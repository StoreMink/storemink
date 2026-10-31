/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock, sqlParamValues, sqlText } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  // platform.ts now imports lib/plans/pricing, whose module scope wraps the
  // price read in unstable_cache. Pass the function straight through so the
  // resolver under test runs uncached.
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
// platform.ts pulls STORE_TAG/FALLBACK_STORE_ID from resolve.ts, whose module
// scope calls unstable_cache — stub the constants instead of loading it.
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));
// Unrelated heavyweight imports of platform.ts — stub so the module loads lean.
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveThemeDefinition: vi.fn(),
}));
vi.mock("@/lib/themes/apply", () => ({ applyTheme: vi.fn() }));
vi.mock("@/lib/storage/cleanup", () => ({
  deleteStorageUrls: vi.fn(async () => ({
    attempted: 0,
    failed: 0,
    unmanaged: 0,
  })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsDeletePrefix: vi.fn(async () => ({ deleted: 0, failed: 0 })),
  // Chat media lives in the private bucket, purged under the same prefix.
  gcsPrivateConfigured: true,
}));
vi.mock("@/lib/domains/cleanup", () => ({
  cleanupDetachedDomain: vi.fn(async () => ({ failures: [] })),
}));
vi.mock("@/lib/auth/firebase-users", () => ({
  deleteAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/firebase-admin", () => ({
  isFirebaseAdminConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/authorized-domains", () => ({
  removeAuthorizedHosts: vi.fn(async () => ({ removed: [] })),
}));
// deleteStore's repair pass (GST design 5.5). Mocked whole, so nothing here
// reads the reconciliation tables through the shared mock db or reaches a
// gateway; by default it found nothing to repair.
const reconcile = vi.hoisted(() => ({
  issueCapturedDrafts: vi.fn(async () => ({
    considered: 0,
    issued: 0,
    completed: 0,
    filed: 0,
    deferred: 0,
    unissued: 0,
    errors: 0,
    more: false,
  })),
  countOpenReconciliationItems: vi.fn(),
  listReconciliationItems: vi.fn(),
  resolveReconciliationItem: vi.fn(),
}));
vi.mock("@/lib/billing/reconcile", () => reconcile);

// The takedown checks deleteStore and setStoreStatus make (stage T17). The
// hold check and the block count are mocked so the cases above see no hold
// and no block, and so neither opens a scope on the shared mock db: their
// positional selects and execute indexes are pinned. deleteRefusalForError
// and STORE_DELETE_REFUSALS stay real. The moderation record is mocked so a
// test can say what was recorded, and on which connection.
const moderation = vi.hoisted(() => ({
  storeDeleteRefusal: vi.fn(
    async (): Promise<{
      reason: "hold" | "archive";
      message: string;
      holdId: string | null;
    } | null> => null,
  ),
  listBlocks: vi.fn(
    async (): Promise<{ rows: unknown[]; total: number }> => ({
      rows: [],
      total: 0,
    }),
  ),
  recordModerationEvent: vi.fn(async (): Promise<string> => "event-1"),
}));
vi.mock("@/lib/moderation/holds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/holds")>()),
  storeDeleteRefusal: moderation.storeDeleteRefusal,
}));
vi.mock("@/lib/moderation/console-read", () => ({
  listBlocks: moderation.listBlocks,
}));
vi.mock("@/lib/moderation/record", () => ({
  recordModerationEvent: moderation.recordModerationEvent,
}));

// The GST console's reads and saves (GST Stage 11). The impact read and the
// invoice list are mocked whole; the three tax saves are mocked over the real
// module so earliestStartAfterNotice (which the notices read uses) stays real.
const gst = vi.hoisted(() => ({
  getGstChangeImpact: vi.fn(async () => ({
    ok: true as const,
    impact: { renewals: 0, rows: [], truncated: false },
  })),
  buildInvoiceList: vi.fn(async () => ({
    ok: true as const,
    month: "2026-10",
    fileName: "storemink-invoices-2026-10.csv",
    rows: [],
    csv: "\uFEFFInvoice number\r\n",
  })),
  saveTaxIdentity: vi.fn(async () => ({ ok: true as const })),
  scheduleTaxChange: vi.fn(async () => ({
    ok: true as const,
    applied: "now" as const,
    startsAt: null,
  })),
  cancelScheduledTaxChange: vi.fn(async () => ({ ok: true as const })),
  getPlatformTaxSettings: vi.fn(async (): Promise<unknown> => null),
}));
// The preview's per-operator limit (review R3-06). Allowed unless a test says.
const limits = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: limits.rateLimit }));
vi.mock("@/lib/billing/gst-impact", () => ({
  getGstChangeImpact: gst.getGstChangeImpact,
}));
vi.mock("@/lib/billing/invoice-list", () => ({
  buildInvoiceList: gst.buildInvoiceList,
}));
vi.mock("@/lib/billing/platform-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/platform-settings")>()),
  saveTaxIdentity: gst.saveTaxIdentity,
  scheduleTaxChange: gst.scheduleTaxChange,
  cancelScheduledTaxChange: gst.cancelScheduledTaxChange,
  getPlatformTaxSettings: gst.getPlatformTaxSettings,
}));

// The ported data layer: with* runners invoke the callback with the mock db.
// getPlatformViewer reads platform_admins (select #1), then the action's own
// reads follow — all share this one mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  deleteStore,
  setStorePlan,
  setStoreStatus,
  grantAiCredits,
  savePlanCreditAllowances,
  saveMinkCreditPacks,
  saveTaxIdentitySettings,
  scheduleGstChange,
  cancelGstChange,
  getGstChangePreview,
  getGstChangeNotices,
  exportInvoiceList,
  getTaxSettings,
} from "./platform";
import { DEFAULT_TAX_SETTINGS } from "@/lib/billing/platform-settings";
import { getServerUser } from "@/lib/auth/server-user";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { isFirebaseAdminConfigured } from "@/lib/auth/firebase-admin";
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import { gcsDeletePrefix } from "@/lib/storage/gcs";
import { cleanupDetachedDomain } from "@/lib/domains/cleanup";
import { removeAuthorizedHosts } from "@/lib/auth/authorized-domains";
import { ROOT_DOMAIN } from "@/lib/store/host";
import {
  billingInvoices,
  billingReconciliationItems,
  billingSubscriptions,
  stores,
} from "@/drizzle/schema";
import { STORE_DELETE_REFUSALS } from "@/lib/moderation/holds";
import { withService } from "@/lib/db/client";
import { revalidatePath, revalidateTag } from "next/cache";

/** When the store row itself was deleted (drafts go first, see deleteStore). */
function storeDeleteOrder(db: any): number {
  const index = vi
    .mocked(db.delete)
    .mock.calls.findIndex(([table]: unknown[]) => table === stores);
  return vi.mocked(db.delete).mock.invocationCallOrder[index]!;
}

const OPERATOR_EMAIL = "op@storemink.com";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

// The platform-viewer gate row (superadmin unless overridden).
function viewer(role: string | null = "superadmin") {
  return role ? [{ email: OPERATOR_EMAIL, role }] : [];
}

// setStorePlan: select #1 = the viewer gate, select #2 = the target store.
function setup(selectQueue: any[][], returning: any[] = [{ id: "s1" }]) {
  dbHolder.current = makeDbMock({ selectQueue, returning });
}

describe("setStorePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    // viewer superadmin, target store on free.
    setup([viewer(), [{ plan: "free", plan_expires_at: null }]]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects a caller who is not a platform admin at all", async () => {
    setup([viewer(null)]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/superadmin/i);
  });

  it("rejects unknown plan ids (incl. the retired 'growth' and 'starter')", async () => {
    setup([viewer()]);
    expect((await setStorePlan("s1", "growth")).error).toMatch(/invalid plan/i);
    setup([viewer()]);
    expect((await setStorePlan("s1", "starter")).error).toMatch(
      /invalid plan/i,
    );
    setup([viewer()]);
    expect((await setStorePlan("s1", "PRO")).error).toMatch(/invalid plan/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects when the store is already on the target plan with the same expiry", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/already on pro/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("allows re-granting the same plan with a different expiry", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "pro", { expiresAt: FUTURE });
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "pro",
      planSource: "comp",
      planExpiresAt: FUTURE,
    });
  });

  it("allows downgrades (operator may set any plan)", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "basic",
      planSource: "comp",
      planExpiresAt: null,
    });

    setup([viewer(), [{ plan: "basic", plan_expires_at: null }]]);
    const res2 = await setStorePlan("s1", "free");
    expect(res2.success).toBe(true);
  });

  it("rejects an unparseable or past expiry", async () => {
    setup([viewer()]);
    expect(
      (await setStorePlan("s1", "pro", { expiresAt: "not-a-date" })).error,
    ).toMatch(/invalid expiry/i);
    setup([viewer()]);
    expect(
      (await setStorePlan("s1", "pro", { expiresAt: PAST })).error,
    ).toMatch(/future/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("sets a timed plan, marks it comp, audits with the expiry, and busts the cache", async () => {
    const res = await setStorePlan("s1", "pro", { expiresAt: FUTURE });
    expect(res.success).toBe(true);

    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "pro",
      planSource: "comp",
      planExpiresAt: FUTURE,
    });
    // Audit row records who did what and until when.
    expect(dbHolder.current.calls.values[0]).toEqual({
      storeId: "s1",
      fromPlan: "free",
      toPlan: "pro",
      source: "operator",
      actor: OPERATOR_EMAIL,
      note: "expires 2030-01-01",
    });
    expect(revalidateTag).toHaveBeenCalled();
  });

  it("an indefinite paid grant audits as such", async () => {
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      toPlan: "basic",
      note: "indefinite",
    });
  });

  it("the free plan never carries an expiry (ignored if sent)", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "free", { expiresAt: FUTURE });
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "free",
      planSource: "comp",
      planExpiresAt: null,
    });
  });

  describe("★★ never below a plan the store pays for (owner decision D12)", () => {
    // stores.plan is all this writes: the subscription keeps renewing at its
    // own plan and the next cycle turn raises the store back. So a lower plan
    // here takes paid features away while the merchant keeps paying.
    const refusal = (plan: string) =>
      `This store pays for ${plan} by subscription, so a lower plan set here would not stop its renewals and would be raised again at the next one. To end it, use Cancel at the end of the cycle or End the plan now on the store's page.`;
    const paying = (sub_state: string, sub_plan: string, plan = sub_plan) => ({
      plan,
      plan_expires_at: null,
      sub_state,
      sub_plan,
    });

    it.each(["active", "past_due", "grace"])(
      "refuses Free and any lower plan while the subscription is %s",
      async (state) => {
        for (const target of ["free", "basic"]) {
          setup([viewer(), [paying(state, "pro")]]);
          const res = await setStorePlan("s1", target);
          expect(res.error).toBe(refusal("Pro"));
          expect(dbHolder.current.calls.update).toHaveLength(0);
          expect(dbHolder.current.calls.insert).toHaveLength(0);
        }
        setup([viewer(), [paying(state, "basic")]]);
        expect((await setStorePlan("s1", "free")).error).toBe(refusal("Basic"));
      },
    );

    it("★ refuses by the PAID plan, even when a comp raised stores.plan", async () => {
      // Paying Basic, comped to Pro: setting Free is still below what they pay.
      setup([viewer(), [paying("active", "basic", "pro")]]);
      expect((await setStorePlan("s1", "free")).error).toBe(refusal("Basic"));
    });

    it("allows the same plan with a new expiry, or a higher one (a comp is a floor)", async () => {
      setup([viewer(), [paying("active", "basic")]]);
      const same = await setStorePlan("s1", "basic", { expiresAt: FUTURE });
      expect(same.success).toBe(true);

      setup([viewer(), [paying("grace", "basic")]]);
      const higher = await setStorePlan("s1", "pro");
      expect(higher.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toMatchObject({ plan: "pro" });
    });

    it.each(["cancelled", "downgraded", "free"])(
      "allows any plan once the subscription is %s",
      async (state) => {
        setup([viewer(), [paying(state, "pro")]]);
        const res = await setStorePlan("s1", "free");
        expect(res.success).toBe(true);
        expect(dbHolder.current.calls.set[0]).toMatchObject({ plan: "free" });
      },
    );

    it("★ reads the subscription with the store, in one LEFT-joined statement", async () => {
      setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
      // No subscription row (the join's columns come back null): allowed.
      expect((await setStorePlan("s1", "free")).success).toBe(true);
      const [table, on] = dbHolder.current.calls.leftJoin[0];
      expect(table).toBe(billingSubscriptions);
      expect(new PgDialect().sqlToQuery(on).sql).toBe(
        '"billing_subscriptions"."store_id" = "stores"."id"',
      );
    });
  });

  it("still succeeds when the audit insert fails (best-effort trail)", async () => {
    setup([viewer(), [{ plan: "free", plan_expires_at: null }]]);
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("boom");
    });
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
  });
});

describe("grantAiCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    // viewer superadmin, store exists.
    setup([viewer(), [{ id: "s1" }]]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await grantAiCredits("s1", 50);
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects non-integer, zero and oversized amounts", async () => {
    setup([viewer()]);
    expect((await grantAiCredits("s1", 0)).error).toMatch(/whole number/i);
    setup([viewer()]);
    expect((await grantAiCredits("s1", 2.5)).error).toMatch(/whole number/i);
    setup([viewer()]);
    expect((await grantAiCredits("s1", 10001)).error).toMatch(/whole number/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects an unknown store", async () => {
    setup([viewer(), []]); // store lookup empty
    const res = await grantAiCredits("nope", 50);
    expect(res.error).toMatch(/not found/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("grants through the atomic RPC with the operator email as the audited ref", async () => {
    const res = await grantAiCredits("s1", 50, "onboarding goodwill");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    const params = sqlParamValues(dbHolder.current.calls.execute[0]);
    expect(params).toEqual([
      "s1",
      50,
      "grant",
      OPERATOR_EMAIL,
      "onboarding goodwill",
    ]);
  });

  it("surfaces an RPC failure as a friendly error", async () => {
    dbHolder.current.db.execute = vi.fn(() => {
      throw new Error("boom");
    });
    const res = await grantAiCredits("s1", 50);
    expect(res.error).toMatch(/could not grant/i);
  });
});

describe("deleteStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
  });

  it("deletes every attached owner, customer and POS staff login", async () => {
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [{ id: "owner-uid", email: "owner@example.com" }],
      [{ id: "customer-uid", email: "customer@example.com" }],
      [
        { user_id: "pos-staff-uid", email: "staff@example.com" },
        { user_id: "pos-staff-uid", email: "staff@example.com" },
        { user_id: null, email: "pending@example.com" },
      ],
      // One empty result for each store-scoped media table scanned before the
      // database cascade. Their contents are irrelevant to this regression.
      ...Array.from({ length: 15 }, () => []),
      // No remaining admin/customer/POS relationships or platform operator.
      [],
      [],
      [],
      [],
    ]);

    const res = await deleteStore("s1");

    expect(res).toEqual({ success: true });
    expect(deleteStorageUrls).toHaveBeenCalledWith([]);
    expect(gcsDeletePrefix).toHaveBeenCalledWith("stores/s1/");
    expect(gcsDeletePrefix).toHaveBeenCalledWith("stores/s1/", "private");
    expect(deleteAuthUser).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deleteAuthUser).mock.calls.map(([uid]) => uid)).toEqual([
      "owner-uid",
      "customer-uid",
      "pos-staff-uid",
    ]);
  });

  it("keeps a login that still belongs to another store or the operator console", async () => {
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [{ id: "shared-admin", email: "owner@example.com" }],
      [{ id: "platform-op", email: OPERATOR_EMAIL }],
      [{ user_id: "orphan-pos", email: "staff@example.com" }],
      ...Array.from({ length: 15 }, () => []),
      [{ id: "shared-admin" }],
      [],
      [],
      [{ email: OPERATOR_EMAIL }],
    ]);

    const res = await deleteStore("s1");

    expect(res.success).toBe(true);
    // A kept login is named, so the operator knows its email will not sign
    // up as new — the deletion otherwise reads as a complete purge.
    expect(res.warning).toBe(
      `Kept 2 logins that another store or the operator console still uses (owner@example.com, ${OPERATOR_EMAIL}). Signing up with those emails reuses the existing account.`,
    );
    expect(res.warning).not.toMatch(/cleanup still needs attention/);
    expect(vi.mocked(deleteAuthUser).mock.calls.map(([uid]) => uid)).toEqual([
      "orphan-pos",
    ]);
  });

  it("purges custom-domain and storage resources and surfaces partial failures", async () => {
    vi.mocked(deleteStorageUrls).mockResolvedValueOnce({
      attempted: 1,
      failed: 1,
      unmanaged: 0,
      foreign: 0,
      shared: 0,
    });
    vi.mocked(gcsDeletePrefix).mockResolvedValueOnce({
      deleted: 0,
      failed: 0,
      error: "bucket unavailable",
    });
    vi.mocked(cleanupDetachedDomain).mockResolvedValueOnce({
      failures: ["TLS certificate resources"],
    });
    setup([
      viewer(),
      [
        {
          id: "s1",
          settings: {
            logo: "https://storage.googleapis.com/media/legacy/logo.webp",
            resend_domain_id: "legacy-resend-1",
          },
          custom_domain: "shop.example.com",
        },
      ],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    const res = await deleteStore("s1");

    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/cleanup still needs attention/i);
    expect(res.warning).toMatch(/referenced media/i);
    expect(res.warning).toMatch(/store media prefix/i);
    expect(res.warning).toMatch(/TLS certificate resources/i);
    expect(cleanupDetachedDomain).toHaveBeenCalledWith(
      "shop.example.com",
      "deleteStore",
      "legacy-resend-1",
    );
  });

  it("removes an orphaned legacy Resend domain even when no custom domain remains", async () => {
    setup([
      viewer(),
      [
        {
          id: "s1",
          settings: { resend_domain_id: "legacy-resend-1" },
          custom_domain: null,
        },
      ],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    expect(await deleteStore("s1")).toEqual({ success: true });
    expect(cleanupDetachedDomain).toHaveBeenCalledWith(
      null,
      "deleteStore",
      "legacy-resend-1",
    );
  });

  it("collects only Google Cloud Storage URLs for the media sweep", async () => {
    const gcs = "https://storage.googleapis.com/media/stores/s1/logo.webp";
    setup([
      viewer(),
      [
        {
          id: "s1",
          settings: {
            logo: gcs,
            banner: "https://cdn.example.com/media/banner.png",
          },
          custom_domain: null,
        },
      ],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    expect(await deleteStore("s1")).toEqual({ success: true });
    expect(deleteStorageUrls).toHaveBeenCalledWith([gcs]);
  });

  it("★ takes an image inside an HTML body without the backslash JSON adds", async () => {
    // The rows are scanned as JSON, which writes src="..." as src=\"...\" and
    // a newline as \n. A URL that kept that backslash resolves to `<path>/`,
    // which names no object, so the image would quietly stay in the bucket.
    const inBlog = "https://storage.googleapis.com/media/blog/old-cover.png";
    const inSection = "https://storage.googleapis.com/media/sections/hero.webp";
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [],
      [],
      [],
      // MEDIA_TABLES order: products, product_variants, categories, blogs (3),
      // blog_comments, homepage_sections (5), then the rest.
      ...Array.from({ length: 15 }, (_, table) =>
        table === 3
          ? [{ id: "b1", content: `<p><img src="${inBlog}" alt="Cover"></p>` }]
          : table === 5
            ? [{ id: "h1", config: { text: `${inSection}\nSee you soon` } }]
            : [],
      ),
    ]);

    expect(await deleteStore("s1")).toEqual({ success: true });
    expect(deleteStorageUrls).toHaveBeenCalledWith([inBlog, inSection]);
  });

  // Phone sign-in needs each store's EXACT subdomain host in Identity
  // Platform's authorizedDomains, so deleting a store must take its host out.
  describe("the store's own sign-in host", () => {
    const HOST = `acme.${ROOT_DOMAIN}`;

    function storeRows(failDelete = false) {
      dbHolder.current = makeDbMock({
        selectQueue: [
          viewer(),
          [{ id: "s1", slug: "acme", settings: {}, custom_domain: null }],
          [],
          [],
          [],
          ...Array.from({ length: 15 }, () => []),
        ],
        failDeleteFor: failDelete ? [stores] : [],
      });
    }

    it("is removed exactly, and only after the store row is gone", async () => {
      storeRows();

      expect(await deleteStore("s1")).toEqual({ success: true });

      expect(removeAuthorizedHosts).toHaveBeenCalledWith([HOST], ROOT_DOMAIN);
      const deleted = storeDeleteOrder(dbHolder.current.db);
      const removed = vi.mocked(removeAuthorizedHosts).mock
        .invocationCallOrder[0];
      expect(deleted).toBeLessThan(removed!);
    });

    it("★ is removed BEFORE the slow media and storage cleanup", async () => {
      // The slug is free once the row is gone; a store re-created on it while
      // a large purge ran would otherwise lose its freshly added host.
      storeRows();

      await deleteStore("s1");

      const removed = vi.mocked(removeAuthorizedHosts).mock
        .invocationCallOrder[0]!;
      expect(removed).toBeLessThan(
        vi.mocked(deleteStorageUrls).mock.invocationCallOrder[0]!,
      );
      expect(removed).toBeLessThan(
        vi.mocked(gcsDeletePrefix).mock.invocationCallOrder[0]!,
      );
    });

    it("surfaces a failed removal as cleanup that needs attention", async () => {
      vi.mocked(removeAuthorizedHosts).mockResolvedValueOnce({
        removed: [],
        error: "PERMISSION_DENIED",
      });
      storeRows();

      const res = await deleteStore("s1");

      expect(res.success).toBe(true);
      expect(res.warning).toBe(
        `The store data was deleted, but cleanup still needs attention: Identity Platform authorized domain ${HOST}.`,
      );
    });

    it("a thrown removal is still a warning, never a failed delete", async () => {
      vi.mocked(removeAuthorizedHosts).mockRejectedValueOnce(
        new Error("socket hang up"),
      );
      storeRows();

      const res = await deleteStore("s1");

      expect(res.success).toBe(true);
      expect(res.warning).toMatch(/Identity Platform authorized domain/);
    });

    it("is kept when the database delete fails, because the store still exists", async () => {
      storeRows(true);

      expect(await deleteStore("s1")).toEqual({
        error: "Could not delete the store. Please try again.",
      });
      expect(removeAuthorizedHosts).not.toHaveBeenCalled();
    });

    it("is untouched for a store that was not found", async () => {
      setup([viewer(), []]);

      expect(await deleteStore("missing")).toEqual({
        error: "Store not found.",
      });
      expect(removeAuthorizedHosts).not.toHaveBeenCalled();
    });

    it("goes alongside a custom domain's cleanup, which owns that domain's hosts", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          viewer(),
          [
            {
              id: "s1",
              slug: "acme",
              settings: {},
              custom_domain: "shop.example.com",
            },
          ],
          [],
          [],
          [],
          ...Array.from({ length: 15 }, () => []),
        ],
      });

      expect(await deleteStore("s1")).toEqual({ success: true });
      expect(cleanupDetachedDomain).toHaveBeenCalledWith(
        "shop.example.com",
        "deleteStore",
        null,
      );
      expect(removeAuthorizedHosts).toHaveBeenCalledWith([HOST], ROOT_DOMAIN);
      // The subdomain host does not wait on certificate deprovisioning.
      expect(
        vi.mocked(removeAuthorizedHosts).mock.invocationCallOrder[0]!,
      ).toBeLessThan(
        vi.mocked(cleanupDetachedDomain).mock.invocationCallOrder[0]!,
      );
    });
  });

  it("warns instead of claiming auth cleanup succeeded when Identity Platform is unavailable", async () => {
    vi.mocked(isFirebaseAdminConfigured).mockReturnValueOnce(false);
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [{ id: "owner-uid", email: "owner@example.com" }],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    const res = await deleteStore("s1");
    expect(res.warning).toMatch(/Identity Platform is not configured/i);
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });

  it("★★ gives the cascade its own 5-minute statement limit, inside the delete's transaction", async () => {
    // Every pool cuts a statement at 30 s; the one DELETE that removes a
    // whole store measured 13.9 s locally for a 200k-order store, so it sets
    // its own bound with SET LOCAL, which ends with its transaction.
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    expect(await deleteStore("s1")).toEqual({ success: true });

    const db = dbHolder.current.db;
    const statements = dbHolder.current.calls.execute.map((query: unknown) =>
      sqlText(query),
    );
    // The transaction's first two statements; then the subscription lock
    // and the unissued AI credit receipts (both pinned below).
    expect(statements.slice(0, 2)).toEqual([
      "set local statement_timeout = '5min'",
      "set constraints all deferred",
    ]);
    const [limitAt, deferAt] = vi.mocked(db.execute).mock.invocationCallOrder;
    const deleteAt = storeDeleteOrder(db);
    // ★ The same transaction as the DELETE: set after that withService call
    //   began (the scan is an earlier one), and before the cascade runs.
    const opened = vi
      .mocked(withService)
      .mock.invocationCallOrder.filter((order) => order < deleteAt);
    expect(limitAt).toBeGreaterThan(Math.max(...opened));
    expect(limitAt).toBeLessThan(deferAt!);
    expect(deferAt).toBeLessThan(deleteAt);
  });

  it("★★ deletes the store's DRAFT invoices first, in the cascade's transaction, keeping payment evidence", async () => {
    // StoreMink's issued invoices outlive the store (migration 0243: SET NULL),
    // so the cascade no longer removes drafts either. A draft is no document,
    // so it is deleted here, unless a payment against it may have reached the
    // gateway: that attempt is the only record of the money.
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    expect(await deleteStore("s1")).toEqual({ success: true });

    const db = dbHolder.current.db;
    expect(
      vi.mocked(db.delete).mock.calls.map(([table]: unknown[]) => table),
    ).toEqual([billingInvoices, stores]);
    const draftsAt = vi.mocked(db.delete).mock.invocationCallOrder[0]!;
    const storeAt = storeDeleteOrder(db);
    const [, deferAt] = vi.mocked(db.execute).mock.invocationCallOrder;
    // After the checks are deferred, before the store row, and in the SAME
    // withService call: no transaction began between them.
    expect(deferAt).toBeLessThan(draftsAt);
    expect(draftsAt).toBeLessThan(storeAt);
    const opened = vi.mocked(withService).mock.invocationCallOrder;
    expect(opened.some((at) => at > draftsAt && at < storeAt)).toBe(false);

    // Only this store's unissued rows, and never one with live evidence.
    // ★ Rendered by the real dialect, so the COLUMN each predicate names is
    //   pinned: sqlText keeps only the literal chunks, and " is null" held just
    //   as well for paid_at, which would delete every issued but unpaid invoice.
    const where = dbHolder.current.calls.where.find((clause: unknown) =>
      sqlText(clause).includes("billing_payment_attempts"),
    );
    const rendered = new PgDialect().sqlToQuery(where);
    expect(rendered.sql).toContain('"billing_invoices"."store_id" = $1');
    expect(rendered.sql).toContain('"billing_invoices"."finalized_at" is null');
    expect(rendered.sql).not.toContain("paid_at");
    expect(rendered.sql).toContain("not exists (select 1 from");
    expect(rendered.sql).toContain('a.invoice_id = "billing_invoices"."id"');
    expect(rendered.sql).toContain("a.provider_order_id is not null");
    expect(rendered.sql).toContain("a.state not in ('failed', 'cancelled')");
    expect(rendered.params).toEqual(["s1"]);
  });

  it("★ keeps the store's OPEN reconciliation items, detached, in the cascade's transaction", async () => {
    // Their store key cascades (migration 0014), and an open or "needs
    // chasing" item can be the only record of a payment: an amount
    // mismatch's observed amount lives nowhere else. A closed item is history.
    setup([
      viewer(),
      [{ id: "s1", settings: {}, custom_domain: null }],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);

    expect(await deleteStore("s1")).toEqual({ success: true });

    const db = dbHolder.current.db;
    expect(
      vi.mocked(db.update).mock.calls.map(([table]: unknown[]) => table),
    ).toEqual([billingReconciliationItems]);
    const detachAt = vi.mocked(db.update).mock.invocationCallOrder[0]!;
    const [, deferAt] = vi.mocked(db.execute).mock.invocationCallOrder;
    const storeAt = storeDeleteOrder(db);
    expect(deferAt).toBeLessThan(detachAt);
    expect(detachAt).toBeLessThan(storeAt);
    const opened = vi.mocked(withService).mock.invocationCallOrder;
    expect(opened.some((at) => at > detachAt && at < storeAt)).toBe(false);

    const set = dbHolder.current.calls.set[0];
    expect(set.storeId).toBeNull();
    const detail = new PgDialect().sqlToQuery(set.detail);
    expect(detail.sql).toBe(
      `"billing_reconciliation_items"."detail" || jsonb_build_object('storeDeleted', true, 'storeName', (select s.name from public.stores s where s.id = $1))`,
    );
    expect(detail.params).toEqual(["s1"]);
    const where = dbHolder.current.calls.where
      .map((clause: any) => new PgDialect().sqlToQuery(clause))
      .find((query: { sql: string }) =>
        query.sql.includes('"billing_reconciliation_items"."status"'),
      );
    expect(where).toMatchObject({
      sql: '("billing_reconciliation_items"."store_id" = $1 and "billing_reconciliation_items"."status" in ($2, $3))',
      params: ["s1", "open", "manual_review"],
    });
  });

  it("★ files a PAID AI credit purchase whose receipt never issued before its row cascades, and says so", async () => {
    // No invoice to keep, no payment attempt, and ai_credit_purchases
    // cascades: without this the payment ids and amount of a paid sale left
    // no trace at all.
    dbHolder.current = makeDbMock({
      selectQueue: [
        viewer(),
        [{ id: "s1", settings: {}, custom_domain: null }],
        [],
        [],
        [],
        ...Array.from({ length: 15 }, () => []),
      ],
      // timeout, deferral, the subscription lock (no subscription), filing.
      executeQueue: [[], [], [], [{ id: "item-9" }]],
    });

    expect(await deleteStore("s1")).toEqual({
      success: true,
      warning:
        "1 paid AI credit purchase has no issued receipt. It is now in Billing & tax > Reconciliation, so the payment is not lost.",
    });

    const db = dbHolder.current.db;
    const fileIndex = dbHolder.current.calls.execute.findIndex(
      (query: unknown) => sqlText(query).includes("ai_credit_purchases"),
    );
    expect(fileIndex).toBe(3);
    const filing = new PgDialect().sqlToQuery(
      dbHolder.current.calls.execute[fileIndex],
    );
    expect(filing.sql).toContain(
      "insert into public.billing_reconciliation_items",
    );
    expect(filing.sql).toContain("select null, 'orphan_payment', 'open'");
    expect(filing.sql).toContain(
      "join public.billing_invoices i on i.id = p.invoice_id",
    );
    expect(filing.sql).toContain("p.store_id = $1");
    expect(filing.sql).toContain("p.status = 'paid'");
    expect(filing.sql).toContain("i.finalized_at is null");
    expect(filing.sql).toContain("on conflict do nothing");
    // ★ At the amount CHARGED (GST design 5.5): a Rs 59 pack charged Rs 69.62
    //   is filed as 6962 paise; a purchase from before amount_paise existed
    //   falls back to its list price.
    expect(filing.sql).toContain(
      "coalesce(p.amount_paise, p.amount_inr::bigint * 100)",
    );
    expect(filing.sql).not.toMatch(
      /'open', p\.rzp_payment_id, p\.rzp_order_id,\s*p\.amount_inr/,
    );
    expect(filing.params).toEqual(["s1"]);
    // ★ Before the drafts go: the receipt it joins on is one of them.
    const fileAt = vi.mocked(db.execute).mock.invocationCallOrder[fileIndex]!;
    const draftsAt = vi.mocked(db.delete).mock.invocationCallOrder[0]!;
    expect(fileAt).toBeLessThan(draftsAt);
    expect(fileAt).toBeLessThan(storeDeleteOrder(db));
  });

  describe("★★ money taken leaves an issued invoice (GST design 5.5)", () => {
    function seedStore() {
      setup([
        viewer(),
        [{ id: "s1", settings: {}, custom_domain: null }],
        [],
        [],
        [],
        ...Array.from({ length: 15 }, () => []),
      ]);
    }
    const summary = (over: Record<string, number> = {}) => ({
      considered: 0,
      issued: 0,
      completed: 0,
      filed: 0,
      deferred: 0,
      unissued: 0,
      errors: 0,
      more: false,
      ...over,
    });

    it("★★ issues the store's captured drafts BEFORE the delete's transaction, outside it", async () => {
      // A draft behind a captured payment would otherwise be deleted (a draft
      // is no document) or kept unissued; issued first, the cascade keeps it
      // as a GST invoice with store_id NULL (migration 0243).
      seedStore();
      expect(await deleteStore("s1")).toEqual({ success: true });

      expect(reconcile.issueCapturedDrafts).toHaveBeenCalledTimes(1);
      expect(reconcile.issueCapturedDrafts).toHaveBeenCalledWith({
        storeId: "s1",
      });
      const repairAt =
        reconcile.issueCapturedDrafts.mock.invocationCallOrder[0]!;
      const db = dbHolder.current.db;
      // Before the transaction's first statement and before the store row.
      const [limitAt] = vi.mocked(db.execute).mock.invocationCallOrder;
      expect(repairAt).toBeLessThan(limitAt!);
      expect(repairAt).toBeLessThan(storeDeleteOrder(db));
      // ★ Never nested: called between two withService calls (the scan and
      //   the delete), never while one is open. The mock runs each callback
      //   inside its own invocation, so "outside" means a withService call
      //   began after the repair and before the transaction's first statement.
      const opened = vi.mocked(withService).mock.invocationCallOrder;
      expect(opened.some((at) => at > repairAt && at < limitAt!)).toBe(true);
    });

    it("is not run for a store that was not found", async () => {
      setup([viewer(), []]);
      expect(await deleteStore("missing")).toEqual({
        error: "Store not found.",
      });
      expect(reconcile.issueCapturedDrafts).not.toHaveBeenCalled();
    });

    it("is not run without a superadmin", async () => {
      setup([viewer("member")]);
      expect(await deleteStore("s1")).toEqual({
        error: "Only a platform superadmin can delete a store.",
      });
      expect(reconcile.issueCapturedDrafts).not.toHaveBeenCalled();
    });

    it("a captured payment it filed for a person is named in the result", async () => {
      reconcile.issueCapturedDrafts.mockResolvedValueOnce(
        summary({ considered: 1, issued: 1, filed: 1 }),
      );
      seedStore();
      expect(await deleteStore("s1")).toEqual({
        success: true,
        warning:
          "1 payment was taken against an invoice that was never issued. The invoice is now issued and kept, and the payment is in Billing & tax > Reconciliation, so a person can check what was paid for.",
      });
    });

    it("several are counted", async () => {
      reconcile.issueCapturedDrafts.mockResolvedValueOnce(
        summary({ considered: 2, issued: 2, filed: 2 }),
      );
      seedStore();
      const res = await deleteStore("s1");
      expect(res.warning).toBe(
        "2 payments were taken against an invoice that was never issued. The invoices are now issued and kept, and the payments are in Billing & tax > Reconciliation, so a person can check what was paid for.",
      );
    });

    it("★ a repair that did not finish is said, never reported as a clean purge", async () => {
      reconcile.issueCapturedDrafts.mockResolvedValueOnce(
        summary({ considered: 2, unissued: 1, errors: 1 }),
      );
      seedStore();
      const res = await deleteStore("s1");
      expect(res).toEqual({
        success: true,
        warning:
          "2 captured payments could not be put right before the delete. The payment records are kept; check Billing & tax > Reconciliation and the billing.captured_draft logs.",
      });
    });

    it("a credit receipt it issued needs no note", async () => {
      // Issued straight to paid, nothing filed: the invoice is simply kept.
      reconcile.issueCapturedDrafts.mockResolvedValueOnce(
        summary({ considered: 1, issued: 1 }),
      );
      seedStore();
      expect(await deleteStore("s1")).toEqual({ success: true });
    });
  });

  describe("★★ cycles the store will never enter (renewal-cancel, design 6.9)", () => {
    // The subscription row cascades with the store, so after the delete the
    // refund pass could not tell which cycle the plan reached. deleteStore
    // closes those invoices first, in the cascade's own transaction.
    function seedSubscription(
      sub: { state: string; current_cycle_seq: number } | null,
      rest: unknown[][] = [],
    ) {
      dbHolder.current = makeDbMock({
        selectQueue: [
          viewer(),
          [{ id: "s1", settings: {}, custom_domain: null }],
          [],
          [],
          [],
          ...Array.from({ length: 15 }, () => []),
        ],
        // timeout, deferral, the subscription lock, then the close statements.
        executeQueue: [[], [], sub ? [sub] : [], ...rest],
      });
    }
    const statementsMatching = (fragment: string): number[] =>
      dbHolder.current.calls.execute
        .map((query: unknown, i: number) =>
          sqlText(query).includes(fragment) ? i : -1,
        )
        .filter((i: number) => i >= 0);
    const render = (i: number) => {
      const q = new PgDialect().sqlToQuery(dbHolder.current.calls.execute[i]);
      return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
    };

    it("★★ locks the subscription row BEFORE closing any invoice, in the cascade's transaction", async () => {
      // The order the hourly passes take (subscription, then invoices): a
      // delete racing the billing run waits for it, and they never deadlock.
      seedSubscription({ state: "active", current_cycle_seq: 4 });
      expect(await deleteStore("s1")).toEqual({ success: true });

      // ★ Found by what it DOES (reads the subscription FOR UPDATE), so a
      //   lock moved after the close fails the order check below, not only the
      //   text check.
      const [lockIndex] = statementsMatching(
        "from public.billing_subscriptions",
      ).filter((i) =>
        sqlText(dbHolder.current.calls.execute[i]).includes("for update"),
      );
      const [closeIndex] = statementsMatching(
        "update public.billing_invoices i",
      );
      expect(lockIndex).toBe(2);
      expect(render(lockIndex!)).toEqual({
        sql: "select state, current_cycle_seq from public.billing_subscriptions where store_id = $1 for update",
        params: ["s1"],
      });
      const db = dbHolder.current.db;
      const order = vi.mocked(db.execute).mock.invocationCallOrder;
      const [, deferAt] = order;
      expect(deferAt).toBeLessThan(order[lockIndex!]!);
      expect(order[lockIndex!]!).toBeLessThan(order[closeIndex!]!);
      // Before the detach, the draft delete and the store row; one transaction.
      const detachAt = vi.mocked(db.update).mock.invocationCallOrder[0]!;
      const storeAt = storeDeleteOrder(db);
      expect(order[closeIndex!]!).toBeLessThan(detachAt);
      expect(detachAt).toBeLessThan(storeAt);
      const opened = vi.mocked(withService).mock.invocationCallOrder;
      expect(opened.some((at) => at > order[lockIndex!]! && at < storeAt)).toBe(
        false,
      );
    });

    it.each(["active", "past_due", "grace"])(
      "★★ a %s plan's ISSUED invoices above its cycle become void, paid or not",
      async (state) => {
        seedSubscription({ state, current_cycle_seq: 4 });
        expect(await deleteStore("s1")).toEqual({ success: true });

        const closes = statementsMatching("update public.billing_invoices i");
        expect(closes).toHaveLength(1);
        const { sql, params } = render(closes[0]!);
        expect(sql).toContain("with closing as ( select i.id");
        expect(sql).toContain("where i.store_id = $1");
        expect(sql).toContain("and i.kind = 'subscription'");
        expect(sql).toContain("and i.cycle_seq > $2");
        // closeUnreachedInvoices' list; a draft is never issued, so with
        // finalized_at required below it closes the same invoices as before.
        expect(sql).toContain(
          "and i.status in ('draft', 'open', 'processing', 'paid')",
        );
        // ★ Issued only: drafts keep deleteStore's own handling below.
        expect(sql).toContain("and i.finalized_at is not null");
        expect(sql).toContain("for update");
        expect(sql).toContain("set status = 'void', updated_at = $3");
        expect(params.slice(0, 2)).toEqual(["s1", 4]);
        // Nothing is filed for a person: the refund pass owns these payments.
        expect(statementsMatching("billing_reconciliation_items")).toEqual(
          statementsMatching("ai_credit_purchases"),
        );
      },
    );

    it.each(["cancelled", "downgraded"])(
      "★★ a %s plan: open leftovers close, paid renewals are filed with storeDeleted and storeName",
      async (state) => {
        seedSubscription({ state, current_cycle_seq: 4 }, [
          [],
          [{ id: "item-1" }],
        ]);
        expect(await deleteStore("s1")).toEqual({
          success: true,
          warning:
            "1 renewal was paid for a cycle the ended plan did not reach. It is now in Billing & tax > Reconciliation, so the payment can be refunded.",
        });

        const [close] = statementsMatching("update public.billing_invoices i");
        const closing = render(close!);
        expect(closing.sql).toContain("and i.cycle_seq > $3");
        expect(closing.sql).toContain("and i.status = 'open'");
        expect(closing.sql).toContain("and i.finalized_at is not null");
        // ★ Never one whose payment may still land or already landed.
        expect(closing.sql).toContain(
          "and not exists ( select 1 from public.billing_payment_attempts a where a.invoice_id = i.id and a.state in ('created', 'processing', 'authorized', 'unknown', 'captured'))",
        );
        expect(closing.params.slice(1)).toEqual(["s1", 4]);

        const [file] = statementsMatching("'paid_unreached:'");
        const filing = render(file!);
        expect(filing.sql).toContain(
          "select null, 'state_conflict', 'open', i.id, a.id, a.provider_payment_id",
        );
        expect(filing.sql).toContain("i.total_paise");
        expect(filing.sql).toContain("'repair_key', 'paid_unreached:' || i.id");
        expect(filing.sql).toContain("'storeDeleted', true");
        expect(filing.sql).toContain("'storeName', s.name");
        expect(filing.sql).toContain("pa.state = 'captured'");
        expect(filing.sql).toContain("and i.status = 'paid'");
        expect(filing.sql).toContain("and i.cycle_seq > $2");
        expect(filing.sql).toContain("on conflict do nothing");
        expect(filing.params).toEqual(["s1", 4]);
        // Filed before the store row goes, or the subscription is gone too.
        const order = vi.mocked(dbHolder.current.db.execute).mock
          .invocationCallOrder;
        expect(order[file!]!).toBeLessThan(
          storeDeleteOrder(dbHolder.current.db),
        );
      },
    );

    it.each([
      ["no subscription", null],
      ["a Free subscription", { state: "free", current_cycle_seq: 0 }],
    ])("with %s nothing is closed or filed", async (_label, sub) => {
      seedSubscription(sub);
      expect(await deleteStore("s1")).toEqual({ success: true });
      expect(statementsMatching("from public.billing_subscriptions")).toEqual([
        2,
      ]);
      expect(statementsMatching("update public.billing_invoices i")).toEqual(
        [],
      );
      expect(statementsMatching("'paid_unreached:'")).toEqual([]);
    });
  });
});

describe("savePlanCreditAllowances", () => {
  const ok = [
    { plan: "free", includedCredits: 5 },
    { plan: "basic", includedCredits: 15 },
    { plan: "pro", includedCredits: 60 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    setup([viewer()]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await savePlanCreditAllowances(ok);
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("requires exactly one row per plan", async () => {
    setup([viewer()]);
    expect((await savePlanCreditAllowances(ok.slice(0, 2))).error).toMatch(
      /one allowance for each plan/i,
    );
    setup([viewer()]);
    // Three rows, but one plan twice — a shape that would leave a tier on its
    // old allowance while looking like a complete save.
    expect(
      (await savePlanCreditAllowances([ok[0], ok[1], { ...ok[1] }])).error,
    ).toMatch(/one allowance for each plan/i);
    setup([viewer()]);
    expect(
      (
        await savePlanCreditAllowances([
          ok[0],
          ok[1],
          { ...ok[2], plan: "growth" },
        ])
      ).error,
    ).toMatch(/one allowance for each plan/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects zero, fractional, negative and oversized allowances", async () => {
    for (const bad of [0, -1, 2.5, 100_001]) {
      setup([viewer()]);
      const res = await savePlanCreditAllowances([
        { ...ok[0], includedCredits: bad },
        ok[1],
        ok[2],
      ]);
      expect(res.error).toMatch(/whole number between 1 and 100000/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    }
  });

  // ⚠ The legacy pair is still NOT NULL and the revision this rolls out over
  // still reads it, so all three columns carry the same number until the
  // contract migration drops them. Writing only the new one fails the insert.
  it("writes the new column and both legacy columns to the same number", async () => {
    setup([viewer()]);
    const res = await savePlanCreditAllowances(ok);
    expect(res).toEqual({ success: true });
    expect(dbHolder.current.calls.values).toEqual([
      expect.objectContaining({
        plan: "free",
        includedCredits: 5,
        generationsPerMonth: 5,
        creditsPerMonth: 5,
        updatedBy: OPERATOR_EMAIL,
      }),
      expect.objectContaining({ plan: "basic", includedCredits: 15 }),
      expect.objectContaining({ plan: "pro", includedCredits: 60 }),
    ]);
  });
});

describe("saveMinkCreditPacks", () => {
  const packs = [
    { id: "small", name: "Small", credits: 25, priceInr: 59, popular: false },
    { id: "big", name: "Big", credits: 300, priceInr: 499, popular: true },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    setup([viewer()]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await saveMinkCreditPacks(packs);
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses an empty catalogue", async () => {
    setup([viewer()]);
    const res = await saveMinkCreditPacks([]);
    expect(res.error).toMatch(/at least one credit pack/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses two highlighted packs and a duplicate id", async () => {
    setup([viewer()]);
    expect(
      (
        await saveMinkCreditPacks([
          { ...packs[0], popular: true },
          { ...packs[1], popular: true },
        ])
      ).error,
    ).toMatch(/only one pack can be highlighted/i);
    setup([viewer()]);
    expect(
      (await saveMinkCreditPacks([packs[0], { ...packs[0] }])).error,
    ).toMatch(/duplicate pack id/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a blank name or a non-positive size or price", async () => {
    for (const bad of [
      { ...packs[0], name: "  " },
      { ...packs[0], credits: 0 },
      { ...packs[0], priceInr: 0 },
    ]) {
      setup([viewer()]);
      expect((await saveMinkCreditPacks([bad])).error).toMatch(/^Pack 1: /);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    }
  });

  // ★★ The highlight is cleared before anything is written. The partial unique
  // index allows one `popular` row, so moving the badge from A to B in a single
  // pass collides the moment B is written while A still holds it.
  it("clears the highlight before writing, and stores the row order", async () => {
    setup([viewer()]);
    const res = await saveMinkCreditPacks(packs);
    expect(res).toEqual({ success: true });
    expect(dbHolder.current.calls.set[0]).toEqual({ popular: false });
    expect(dbHolder.current.calls.values).toEqual([
      expect.objectContaining({ id: "small", sortOrder: 0, popular: false }),
      expect.objectContaining({ id: "big", sortOrder: 1, popular: true }),
    ]);
  });

  it("deletes packs the operator removed from the list", async () => {
    setup([viewer()]);
    await saveMinkCreditPacks([packs[0]]);
    expect(dbHolder.current.calls.delete).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The GST console's actions (GST design 5.8 and 6, Stage 11). Each is a public
// endpoint: a superadmin writes, any operator reads, and the invoice list is a
// superadmin's alone.
// ---------------------------------------------------------------------------

describe("the GST console actions", () => {
  function asOperator(role: string | null) {
    dbHolder.current = makeDbMock({ selectQueue: [viewer(role)] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    asOperator("superadmin");
  });

  describe("saveTaxIdentitySettings", () => {
    const identity = {
      legalName: "STOREMINK LLP",
      gstin: "03ABCDE1234F1Z5",
      stateCode: "03",
      addressLine1: "Bala ji Colony",
      addressLine2: "",
      city: "Faridkot",
      postalCode: "151203",
      sacCode: "998314",
      llpin: "ADC-5432",
      registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
      invoicePrefix: "SM",
    };

    it("★★ refuses a member and anyone signed out, before reading or saving", async () => {
      asOperator("member");
      expect(await saveTaxIdentitySettings(identity)).toEqual({
        error: "Only a platform superadmin can change tax settings.",
      });
      asOperator(null);
      expect(await saveTaxIdentitySettings(identity)).toEqual({
        error: "Only a platform superadmin can change tax settings.",
      });
      expect(gst.saveTaxIdentity).not.toHaveBeenCalled();
    });

    it("saves every field as text, with the operator's email, and reloads the page", async () => {
      expect(
        await saveTaxIdentitySettings({ ...identity, gstin: 42, extra: "x" }),
      ).toEqual({ success: true });
      expect(gst.saveTaxIdentity).toHaveBeenCalledWith(
        { ...identity, gstin: "" },
        OPERATOR_EMAIL,
      );
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/billing");
    });

    it("returns the save's refusal word for word", async () => {
      gst.saveTaxIdentity.mockResolvedValueOnce({
        ok: false,
        error: "That GSTIN doesn't look right.",
      } as never);
      expect(await saveTaxIdentitySettings(identity)).toEqual({
        error: "That GSTIN doesn't look right.",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("refuses something that is not a form", async () => {
      expect(await saveTaxIdentitySettings(null)).toEqual({
        error: "Nothing to save.",
      });
      expect(gst.saveTaxIdentity).not.toHaveBeenCalled();
    });
  });

  describe("scheduleGstChange", () => {
    it("★★ refuses a member before saving", async () => {
      asOperator("member");
      expect(await scheduleGstChange({ enabled: true, when: "now" })).toEqual({
        ok: false,
        error: "Only a platform superadmin can change tax settings.",
      });
      expect(gst.scheduleTaxChange).not.toHaveBeenCalled();
    });

    it("★ refuses a change with no start choice, in the save's own words", async () => {
      expect(await scheduleGstChange({ enabled: true, when: "later" })).toEqual(
        { ok: false, error: "Choose when the change starts." },
      );
      expect(gst.scheduleTaxChange).not.toHaveBeenCalled();
    });

    it("★★ coerces what the browser sent: a boolean only when it is true, text only when it is text", async () => {
      await scheduleGstChange({
        enabled: "true",
        inclusive: true,
        ratePercent: "18",
        when: "scheduled",
        startsAt: "2026-11-30T18:30:00.000Z",
        noticeId: 7,
        rateSetByLaw: "yes",
      });
      expect(gst.scheduleTaxChange).toHaveBeenCalledWith(
        {
          enabled: false,
          inclusive: true,
          ratePercent: 18,
          when: "scheduled",
          startsAt: "2026-11-30T18:30:00.000Z",
          noticeId: null,
          rateSetByLaw: false,
        },
        OPERATOR_EMAIL,
      );
    });

    it("a rate that is not a number or text reaches the save as not a number", async () => {
      await scheduleGstChange({
        enabled: true,
        inclusive: false,
        ratePercent: { pct: 18 },
        when: "now",
      });
      const [input] = gst.scheduleTaxChange.mock.calls[0] as unknown as [
        { ratePercent: number; startsAt: unknown },
      ];
      expect(Number.isNaN(input.ratePercent)).toBe(true);
      expect(input.startsAt).toBeUndefined();
    });

    it("reloads the page only when the change was saved", async () => {
      gst.scheduleTaxChange.mockResolvedValueOnce({
        ok: false,
        error: "Choose the notice you emailed merchants.",
      } as never);
      expect(
        await scheduleGstChange({
          enabled: true,
          ratePercent: 18,
          when: "now",
        }),
      ).toEqual({
        ok: false,
        error: "Choose the notice you emailed merchants.",
      });
      expect(revalidatePath).not.toHaveBeenCalled();

      asOperator("superadmin");
      await scheduleGstChange({ enabled: true, ratePercent: 18, when: "now" });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/billing");
    });
  });

  describe("cancelGstChange", () => {
    it("★★ refuses a member", async () => {
      asOperator("member");
      expect(await cancelGstChange()).toEqual({
        error: "Only a platform superadmin can change tax settings.",
      });
      expect(gst.cancelScheduledTaxChange).not.toHaveBeenCalled();
    });

    it("cancels with the operator's email", async () => {
      expect(await cancelGstChange()).toEqual({ success: true });
      expect(gst.cancelScheduledTaxChange).toHaveBeenCalledWith(OPERATOR_EMAIL);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/billing");
    });

    it("★ a refusal still reloads the page, so a change that started shows as started", async () => {
      gst.cancelScheduledTaxChange.mockResolvedValueOnce({
        ok: false,
        error: "This change has already started.",
      } as never);
      expect(await cancelGstChange()).toEqual({
        error: "This change has already started.",
      });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/billing");
    });
  });

  describe("getGstChangePreview", () => {
    it("★★ answers no one who is not an operator", async () => {
      asOperator(null);
      expect(
        await getGstChangePreview({
          enabled: true,
          inclusive: true,
          ratePercent: 18,
        }),
      ).toEqual({ ok: false, reason: "not_allowed" });
      expect(gst.getGstChangeImpact).not.toHaveBeenCalled();
    });

    it("★ a member may read it", async () => {
      asOperator("member");
      const result = await getGstChangePreview({
        enabled: true,
        inclusive: false,
        ratePercent: "12.5",
      });
      expect(result.ok).toBe(true);
      expect(gst.getGstChangeImpact).toHaveBeenCalledWith({
        enabled: true,
        inclusive: false,
        rateBps: 1250,
      });
    });

    it.each([
      [null],
      [{ enabled: "yes", inclusive: true, ratePercent: 18 }],
      [{ enabled: true, inclusive: 1, ratePercent: 18 }],
      [{ enabled: true, inclusive: true, ratePercent: -1 }],
      [{ enabled: true, inclusive: true, ratePercent: 100.5 }],
      [{ enabled: true, inclusive: true, ratePercent: "abc" }],
    ])("refuses a proposal it cannot read (%j)", async (proposal) => {
      expect(await getGstChangePreview(proposal)).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(gst.getGstChangeImpact).not.toHaveBeenCalled();
    });

    describe("★★ is limited per operator (review R3-06)", () => {
      const proposal = { enabled: true, inclusive: true, ratePercent: 18 };

      it("asks the limiter under the operator's own email, 30 a minute", async () => {
        vi.mocked(getServerUser).mockResolvedValue({
          id: "op-1",
          email: "Op@StoreMink.com",
          phone: null,
          phoneConfirmed: true,
          metadata: {},
        } as any);
        await getGstChangePreview(proposal);
        expect(limits.rateLimit).toHaveBeenCalledWith(
          `gst-preview:${OPERATOR_EMAIL}`,
          { max: 30, windowSeconds: 60 },
        );
      });

      it("★ over the limit answers rate_limited and reads no renewals", async () => {
        limits.rateLimit.mockResolvedValueOnce({ allowed: false });
        expect(await getGstChangePreview(proposal)).toEqual({
          ok: false,
          reason: "rate_limited",
        });
        expect(gst.getGstChangeImpact).not.toHaveBeenCalled();
      });

      it("spends nothing on a caller it refuses for other reasons", async () => {
        asOperator(null);
        await getGstChangePreview(proposal);
        asOperator("superadmin");
        await getGstChangePreview(null);
        expect(limits.rateLimit).not.toHaveBeenCalled();
      });
    });
  });

  describe("getTaxSettings", () => {
    it("★★ an unreadable settings row is read_failed, never the defaults (review R3-05)", async () => {
      gst.getPlatformTaxSettings.mockResolvedValueOnce(null);
      expect(await getTaxSettings()).toEqual({
        ok: false,
        reason: "read_failed",
      });
    });

    it("returns the settings it read", async () => {
      gst.getPlatformTaxSettings.mockResolvedValueOnce(DEFAULT_TAX_SETTINGS);
      expect(await getTaxSettings()).toEqual({
        ok: true,
        settings: DEFAULT_TAX_SETTINGS,
      });
    });

    it("answers no one who is not an operator, and reads nothing", async () => {
      asOperator(null);
      expect(await getTaxSettings()).toEqual({
        ok: false,
        reason: "not_allowed",
      });
      expect(gst.getPlatformTaxSettings).not.toHaveBeenCalled();
    });
  });

  describe("getGstChangeNotices", () => {
    const everyOwner = { include: ["owner"], statuses: [], plans: [] };

    it("★★ lists nothing for someone who is not an operator, and reads nothing", async () => {
      asOperator(null);
      expect(await getGstChangeNotices()).toEqual([]);
      expect(dbHolder.current.calls.select).toHaveLength(1);
    });

    it("★ says whether each counts as the notice, and the earliest start it allows", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          viewer("member"),
          [
            {
              id: "n-1",
              title: "GST from December",
              category: "operational",
              status: "sent",
              sent: 12,
              failed: 1,
              sentAt: "2026-10-20 09:30:00+00",
              channels: { email: true },
              audience: everyOwner,
            },
            {
              id: "n-2",
              title: "SMS only",
              category: "operational",
              status: "sent",
              sent: 4,
              failed: 0,
              sentAt: "2026-10-21 09:30:00+00",
              channels: { email: false, sms: true },
              audience: everyOwner,
            },
            {
              id: "n-3",
              title: "Never finished",
              category: "operational",
              status: "failed",
              sent: 0,
              failed: 9,
              sentAt: null,
              channels: { email: true },
              audience: everyOwner,
            },
          ],
        ],
      });
      const notices = await getGstChangeNotices();
      expect(notices).toEqual([
        {
          id: "n-1",
          title: "GST from December",
          sentAt: "2026-10-20T09:30:00.000Z",
          sent: 12,
          failed: 1,
          check: { ok: true },
          earliestStart: expect.any(String),
        },
        {
          id: "n-2",
          title: "SMS only",
          sentAt: "2026-10-21T09:30:00.000Z",
          sent: 4,
          failed: 0,
          check: { ok: false, reason: "not_email" },
          earliestStart: null,
        },
        {
          id: "n-3",
          title: "Never finished",
          sentAt: null,
          sent: 0,
          failed: 9,
          check: { ok: false, reason: "not_sent" },
          earliestStart: null,
        },
      ]);
      // One calendar month on, and never before the notice.
      expect(Date.parse(notices![0].earliestStart!)).toBeGreaterThan(
        Date.parse("2026-11-19T00:00:00.000Z"),
      );
      expect(dbHolder.current.calls.limit).toContain(20);
    });

    it("★ a failed read is null, so the card can say so", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [viewer("superadmin"), new Error("connection reset")],
      });
      expect(await getGstChangeNotices()).toBeNull();
    });
  });

  describe("exportInvoiceList", () => {
    it("★★ is a superadmin's alone: a member and anyone signed out are refused", async () => {
      asOperator("member");
      expect(await exportInvoiceList("2026-10")).toEqual({
        error: "Only a platform superadmin can download the invoice list.",
      });
      asOperator(null);
      expect(await exportInvoiceList("2026-10")).toEqual({
        error: "Only a platform superadmin can download the invoice list.",
      });
      expect(gst.buildInvoiceList).not.toHaveBeenCalled();
    });

    it("returns the month's file name and CSV", async () => {
      expect(await exportInvoiceList("2026-10")).toEqual({
        fileName: "storemink-invoices-2026-10.csv",
        csv: "\uFEFFInvoice number\r\n",
      });
      expect(gst.buildInvoiceList).toHaveBeenCalledWith({ month: "2026-10" });
    });

    it("passes a month that is not text as empty, and a failure in the card's words", async () => {
      gst.buildInvoiceList.mockResolvedValueOnce({
        ok: false,
        reason: "invalid_month",
      } as never);
      expect(await exportInvoiceList(202610)).toEqual({
        error: "Couldn't prepare the invoice list. Please try again.",
      });
      expect(gst.buildInvoiceList).toHaveBeenCalledWith({ month: "" });
    });

    it("★ a month too large for one file says so in the card's words (review R3-08)", async () => {
      gst.buildInvoiceList.mockResolvedValueOnce({
        ok: false,
        reason: "too_many",
      } as never);
      expect(await exportInvoiceList("2026-10")).toEqual({
        error:
          "This month has more invoices than one download can hold. Ask an engineer to export it in parts.",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Stage T17 (takedown design 3.7, 3.8, 6.7; plan A7, A13).
// ---------------------------------------------------------------------------

describe("deleteStore and StoreMink's holds and blocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
  });

  /** A store with nothing attached, as the cases above seed it. */
  function seedStore() {
    setup([
      viewer(),
      [{ id: "s1", slug: "crumb", settings: {}, custom_domain: null }],
      [],
      [],
      [],
      ...Array.from({ length: 15 }, () => []),
    ]);
  }

  /** The DELETE of the store row rejects with `err`; drafts delete as usual. */
  function storeDeleteRejects(err: unknown) {
    const db = dbHolder.current.db;
    const original = vi.mocked(db.delete).getMockImplementation()!;
    vi.mocked(db.delete).mockImplementation((table: unknown) => {
      if (table !== stores) return original(table);
      dbHolder.current.calls.delete.push(table);
      return {
        where: vi.fn(() => Promise.reject(err)),
      };
    });
  }

  it.each([
    [
      "hold",
      "This store is on hold for an investigation, so it can't be deleted. Release the hold first.",
    ],
    [
      "archive",
      "StoreMink is still keeping a copy of something blocked on this store. Try again in a few minutes.",
    ],
  ] as const)(
    "★★ refuses a store with a %s before issueCapturedDrafts and before any write",
    async (reason, sentence) => {
      moderation.storeDeleteRefusal.mockResolvedValueOnce({
        reason,
        message: STORE_DELETE_REFUSALS[reason],
        holdId: reason === "hold" ? "h1" : null,
      });
      seedStore();

      expect(await deleteStore("s1")).toEqual({ error: sentence });

      // Asked once, for this store, with the operator so the refusal is
      // recorded in its own scope (store_delete_refused).
      expect(moderation.storeDeleteRefusal).toHaveBeenCalledTimes(1);
      expect(moderation.storeDeleteRefusal).toHaveBeenCalledWith("s1", {
        actor: OPERATOR_EMAIL,
      });
      // Nothing else ran: no repair, no count, no scan, no statement, no write.
      expect(reconcile.issueCapturedDrafts).not.toHaveBeenCalled();
      expect(moderation.listBlocks).not.toHaveBeenCalled();
      expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
      const calls = dbHolder.current.calls;
      expect(calls.execute).toHaveLength(0);
      expect(calls.insert).toHaveLength(0);
      expect(calls.update).toHaveLength(0);
      expect(calls.delete).toHaveLength(0);
      // The one scope opened is the operator check's own read.
      expect(withService).toHaveBeenCalledTimes(1);
      expect(deleteStorageUrls).not.toHaveBeenCalled();
      expect(gcsDeletePrefix).not.toHaveBeenCalled();
      expect(removeAuthorizedHosts).not.toHaveBeenCalled();
      expect(deleteAuthUser).not.toHaveBeenCalled();
      expect(revalidateTag).not.toHaveBeenCalled();
    },
  );

  it("★★ asks before the scan, the block count and GST's repair", async () => {
    seedStore();
    expect(await deleteStore("s1")).toEqual({ success: true });

    const askedAt = moderation.storeDeleteRefusal.mock.invocationCallOrder[0]!;
    const opened = vi.mocked(withService).mock.invocationCallOrder;
    // Scope 1 is the operator check; scope 2 is the scan.
    expect(askedAt).toBeGreaterThan(opened[0]!);
    expect(askedAt).toBeLessThan(opened[1]!);
    expect(askedAt).toBeLessThan(
      moderation.listBlocks.mock.invocationCallOrder[0]!,
    );
    expect(askedAt).toBeLessThan(
      reconcile.issueCapturedDrafts.mock.invocationCallOrder[0]!,
    );
  });

  it("is not asked without a superadmin, or for the fallback store", async () => {
    setup([viewer("member")]);
    expect(await deleteStore("s1")).toEqual({
      error: "Only a platform superadmin can delete a store.",
    });
    setup([viewer()]);
    expect(await deleteStore("a0000000-0000-4000-8000-000000000001")).toEqual({
      error: "The WholeSip fallback store can't be deleted.",
    });
    expect(moderation.storeDeleteRefusal).not.toHaveBeenCalled();
  });

  it("★ a check that could not be made refuses the delete, changing nothing", async () => {
    moderation.storeDeleteRefusal.mockRejectedValueOnce(
      new Error("connection reset"),
    );
    seedStore();

    expect(await deleteStore("s1")).toEqual({
      error: "Could not delete the store. Please try again.",
    });
    expect(reconcile.issueCapturedDrafts).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.delete).toHaveLength(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it.each([
    [
      "hold",
      "stores: s1 is on hold for an investigation and cannot be deleted",
      "This store is on hold for an investigation, so it can't be deleted. Release the hold first.",
    ],
    [
      "archive",
      "stores: s1 has a StoreMink archive whose files are not copied yet",
      "StoreMink is still keeping a copy of something blocked on this store. Try again in a few minutes.",
    ],
  ] as const)(
    "★★ the trigger's %s refusal from the DELETE reads as the same sentence, and is recorded",
    async (reason, triggerText, sentence) => {
      // A hold set (or an archive started) after the pre-check: Drizzle's
      // error carries the database's message on `cause`.
      seedStore();
      storeDeleteRejects(
        Object.assign(new Error('Failed query: delete from "stores"'), {
          cause: new Error(triggerText),
        }),
      );

      expect(await deleteStore("s1")).toEqual({ error: sentence });

      expect(moderation.recordModerationEvent).toHaveBeenCalledTimes(1);
      expect(moderation.recordModerationEvent).toHaveBeenCalledWith(
        dbHolder.current.db,
        {
          actor: OPERATOR_EMAIL,
          action: "store_delete_refused",
          storeId: "s1",
          detail: { reason, at: "delete" },
        },
      );
      // The store still exists, so nothing outside the database is touched.
      expect(removeAuthorizedHosts).not.toHaveBeenCalled();
      expect(deleteStorageUrls).not.toHaveBeenCalled();
      expect(gcsDeletePrefix).not.toHaveBeenCalled();
      expect(deleteAuthUser).not.toHaveBeenCalled();
    },
  );

  it("the trigger's message is read from the error itself too", async () => {
    seedStore();
    storeDeleteRejects(
      new Error(
        "stores: s1 has a StoreMink archive whose files are not copied yet",
      ),
    );
    expect(await deleteStore("s1")).toEqual({
      error:
        "StoreMink is still keeping a copy of something blocked on this store. Try again in a few minutes.",
    });
  });

  it("a refusal whose record fails still answers the sentence", async () => {
    moderation.recordModerationEvent.mockRejectedValueOnce(
      new Error("insert failed"),
    );
    seedStore();
    storeDeleteRejects(
      new Error(
        "stores: s1 is on hold for an investigation and cannot be deleted",
      ),
    );
    expect(await deleteStore("s1")).toEqual({
      error:
        "This store is on hold for an investigation, so it can't be deleted. Release the hold first.",
    });
  });

  it("any other failure of the DELETE stays the plain error, with nothing recorded", async () => {
    seedStore();
    storeDeleteRejects(new Error("deadlock detected"));
    expect(await deleteStore("s1")).toEqual({
      error: "Could not delete the store. Please try again.",
    });
    expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
  });

  it("★★ records store_deleted for a store that had blocks, after its files are gone", async () => {
    moderation.listBlocks.mockResolvedValueOnce({ rows: [], total: 3 });
    seedStore();

    expect(await deleteStore("s1")).toEqual({ success: true });

    // Counted once, every block of the store (lifted ones too), one row read.
    expect(moderation.listBlocks).toHaveBeenCalledWith({
      storeId: "s1",
      view: "all",
      limit: 1,
    });
    const db = dbHolder.current.db;
    const countedAt = moderation.listBlocks.mock.invocationCallOrder[0]!;
    const [limitAt] = vi.mocked(db.execute).mock.invocationCallOrder;
    // Before the transaction (and before GST's repair), never inside a scope.
    expect(countedAt).toBeLessThan(limitAt!);
    expect(countedAt).toBeLessThan(
      reconcile.issueCapturedDrafts.mock.invocationCallOrder[0]!,
    );

    expect(moderation.recordModerationEvent).toHaveBeenCalledTimes(1);
    expect(moderation.recordModerationEvent).toHaveBeenCalledWith(db, {
      actor: OPERATOR_EMAIL,
      action: "store_deleted",
      storeId: "s1",
      detail: { blocks: 3, slug: "crumb" },
    });
    const recordedAt =
      moderation.recordModerationEvent.mock.invocationCallOrder[0]!;
    // After the store row and after the storage cleanup.
    expect(recordedAt).toBeGreaterThan(storeDeleteOrder(db));
    const purged = vi.mocked(gcsDeletePrefix).mock.invocationCallOrder;
    expect(recordedAt).toBeGreaterThan(Math.max(...purged));
    expect(recordedAt).toBeGreaterThan(
      vi.mocked(deleteStorageUrls).mock.invocationCallOrder[0]!,
    );
    // In a scope of its own, opened after the delete's.
    const opened = vi.mocked(withService).mock.invocationCallOrder;
    expect(opened.some((at) => at > storeDeleteOrder(db))).toBe(true);
  });

  it("records nothing for a store that never had a block", async () => {
    seedStore();
    expect(await deleteStore("s1")).toEqual({ success: true });
    expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
  });

  it("a deletion record that fails is cleanup that needs attention, never a failed delete", async () => {
    moderation.listBlocks.mockResolvedValueOnce({ rows: [], total: 1 });
    moderation.recordModerationEvent.mockRejectedValueOnce(
      new Error("insert failed"),
    );
    seedStore();

    expect(await deleteStore("s1")).toEqual({
      success: true,
      warning:
        "The store data was deleted, but cleanup still needs attention: the takedown record of this deletion.",
    });
  });

  it("★ a block count that could not be read refuses the delete, changing nothing", async () => {
    moderation.listBlocks.mockRejectedValueOnce(new Error("connection reset"));
    seedStore();

    expect(await deleteStore("s1")).toEqual({
      error: "Could not delete the store. Please try again.",
    });
    expect(reconcile.issueCapturedDrafts).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    expect(dbHolder.current.calls.delete).toHaveLength(0);
  });

  it("a database without the takedown tables counts no blocks and deletes", async () => {
    moderation.listBlocks.mockRejectedValueOnce(
      Object.assign(new Error("Failed query"), {
        cause: Object.assign(
          new Error('relation "content_blocks" does not exist'),
          { code: "42P01" },
        ),
      }),
    );
    seedStore();
    expect(await deleteStore("s1")).toEqual({ success: true });
    expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
  });
});

describe("setStoreStatus (takedown design 6.7, plan A13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
  });

  const BLOCK_SENTENCE =
    "This store is suspended by a block on a complaint. Lift the block in Complaints.";

  it("is for a superadmin only", async () => {
    setup([viewer("member")]);
    expect(
      await setStoreStatus("s1", "suspended", {
        kind: "other",
        note: "Owner asked",
      }),
    ).toEqual({ error: "Only a platform superadmin can change store status." });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★★ refuses a suspension for a complaint, sending the operator to Suspend on a complaint", async () => {
    setup([viewer()]);
    expect(
      await setStoreStatus("s1", "suspended", {
        kind: "complaint",
        note: "A court order",
      }),
    ).toEqual({
      error:
        "Use Suspend on a complaint instead, so that StoreMink keeps a copy of the store and tells its owners.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["no reason", undefined],
    ["an empty note", { kind: "other" as const, note: "   " }],
  ])("★ a suspension needs a note (%s)", async (_label, reason) => {
    setup([viewer()]);
    expect(await setStoreStatus("s1", "suspended", reason)).toEqual({
      error: "Write why you are suspending this store.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("refuses a note over 2,000 characters", async () => {
    setup([viewer()]);
    expect(
      await setStoreStatus("s1", "suspended", {
        kind: "other",
        note: "x".repeat(2001),
      }),
    ).toEqual({ error: "Keep the note under 2,000 characters." });
  });

  it("★★ suspends for another reason, recording store_suspended with the reason in the update's transaction", async () => {
    setup([viewer()]);
    expect(
      await setStoreStatus("s1", "suspended", {
        kind: "other",
        note: "  The owner asked us to pause the store.  ",
      }),
    ).toEqual({ success: true });

    const db = dbHolder.current.db;
    expect(dbHolder.current.calls.update).toEqual([stores]);
    expect(dbHolder.current.calls.set).toEqual([{ status: "suspended" }]);
    const updatedAt = vi.mocked(db.update).mock.invocationCallOrder[0]!;
    // A suspension reads no block first: the one read before the update is
    // the operator check's.
    expect(
      vi
        .mocked(db.select)
        .mock.invocationCallOrder.filter((at: number) => at < updatedAt),
    ).toHaveLength(1);
    expect(moderation.recordModerationEvent).toHaveBeenCalledWith(db, {
      actor: OPERATOR_EMAIL,
      action: "store_suspended",
      storeId: "s1",
      detail: {
        reason: "other",
        note: "The owner asked us to pause the store.",
      },
    });
    // The update and the record share one scope: none opens between them.
    const recordedAt =
      moderation.recordModerationEvent.mock.invocationCallOrder[0]!;
    expect(updatedAt).toBeLessThan(recordedAt);
    expect(
      vi
        .mocked(withService)
        .mock.invocationCallOrder.some(
          (at) => at > updatedAt && at < recordedAt,
        ),
    ).toBe(false);
    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
  });

  it("★★ refuses to reactivate a store suspended by a live block, before the update", async () => {
    // viewer, then the live whole-store block.
    setup([viewer(), [{ id: "block-1" }]]);
    expect(await setStoreStatus("s1", "active")).toEqual({
      error: BLOCK_SENTENCE,
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();

    // The block it looks for: a live block of kind "store" on this store.
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[1]);
    expect(where.sql).toBe(
      '("content_blocks"."item_kind" = $1 and "content_blocks"."item_id" = $2 and "content_blocks"."lifted_at" is null)',
    );
    expect(where.params).toEqual(["store", "s1"]);
  });

  it("reactivates a store no block holds, recording store_reactivated", async () => {
    setup([viewer(), []]);
    expect(await setStoreStatus("s1", "active")).toEqual({ success: true });
    expect(dbHolder.current.calls.set).toEqual([{ status: "active" }]);
    expect(moderation.recordModerationEvent).toHaveBeenCalledWith(
      dbHolder.current.db,
      {
        actor: OPERATOR_EMAIL,
        action: "store_reactivated",
        storeId: "s1",
        detail: {},
      },
    );
  });

  it("★ the trigger's refusal (a block made after the read) maps to the same sentence", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [viewer(), []],
      failUpdateFor: [stores],
    });
    const db = dbHolder.current.db;
    vi.mocked(db.update).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.reject(
              Object.assign(new Error('Failed query: update "stores"'), {
                cause: new Error(
                  "stores: s1 is suspended by a StoreMink block; lift the block instead",
                ),
              }),
            ),
          ),
        })),
      })),
    }));
    expect(await setStoreStatus("s1", "active")).toEqual({
      error: BLOCK_SENTENCE,
    });
    expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
  });

  it("any other failure is the plain error", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [viewer(), []],
      failUpdateFor: [stores],
    });
    expect(await setStoreStatus("s1", "active")).toEqual({
      error: "Could not update the store. Please try again.",
    });
  });

  it("★ a record that fails fails the change, so a status never moves unrecorded", async () => {
    moderation.recordModerationEvent.mockRejectedValueOnce(
      new Error("insert failed"),
    );
    setup([viewer()]);
    expect(
      await setStoreStatus("s1", "suspended", { kind: "other", note: "Asked" }),
    ).toEqual({ error: "Could not update the store. Please try again." });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("a store that does not exist is said, and nothing is recorded", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [viewer()],
      returning: [],
    });
    expect(
      await setStoreStatus("missing", "suspended", {
        kind: "other",
        note: "Asked",
      }),
    ).toEqual({ error: "Store not found." });
    expect(moderation.recordModerationEvent).not.toHaveBeenCalled();
  });
});
