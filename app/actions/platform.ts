"use server";

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { isFirebaseAdminConfigured } from "@/lib/auth/firebase-admin";
import { authIdsInUse } from "@/lib/auth/identity-usage";
import { removeAuthorizedHosts } from "@/lib/auth/authorized-domains";
import { storeAuthHosts } from "@/lib/auth/store-auth-hosts";
import { logError } from "@/lib/observability/logger";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  admins,
  aiCreditBalances,
  aiCreditLedger,
  aiUsage,
  blogComments,
  blogs,
  billingInvoices,
  billingReconciliationItems,
  billingSubscriptions,
  cardColors,
  categories,
  emailCampaigns,
  homepageSections,
  mediaAssets,
  minkCreditPacks,
  minkPlanAllowances,
  orderReturns,
  planEvents,
  planPrices,
  platformAdmins,
  posStaff,
  productReviews,
  productVariants,
  products,
  storeBillingSettings,
  storeChrome,
  storePages,
  storePaymentProviders,
  stores,
  users,
} from "@/drizzle/schema";
import { STORE_TAG, FALLBACK_STORE_ID } from "@/lib/store/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { resolveThemeDefinition } from "@/lib/themes/runtime-registry";
import { applyTheme } from "@/lib/themes/apply";
import {
  NotADemoStoreError,
  upsertDemoStoreRow,
} from "@/lib/themes/demo-store";
import {
  MERCHANT_STORES_CTE,
  merchantStoreCondition,
} from "@/lib/platform/merchant-stores";
import {
  countOpenReconciliationItems,
  listReconciliationItems,
  resolveReconciliationItem,
  type ReconciliationItem,
} from "@/lib/billing/reconcile";
import {
  getPlatformTaxSettings,
  savePlatformTaxSettings,
  type PlatformTaxSettings,
  type TaxSettingsInput,
} from "@/lib/billing/platform-settings";
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import { gcsDeletePrefix, gcsPrivateConfigured } from "@/lib/storage/gcs";
import { storeStoragePrefix } from "@/lib/storage/paths";
import { cleanupDetachedDomain } from "@/lib/domains/cleanup";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { PLAN_IDS, PLAN_META, normalizePlan, type Plan } from "@/lib/plans";
import {
  EXTRA_LOCATION_KEY,
  bustPlanPricing,
  getExtraLocationPricingLive,
  getPlanPricingLive,
  type ExtraLocationPricing,
  type PlanPricing,
} from "@/lib/plans/pricing";
import { minkCreditCycleAt } from "@/lib/ai/quota";
import { validateCreditPacks, type CreditPack } from "@/lib/ai/credits";
import { bustPlanAllowances } from "@/lib/plans/allowances";

// A Storemink platform operator (from platform_admins, by JWT email).
export interface PlatformViewer {
  email: string;
  role: "superadmin" | "member";
}

export async function getPlatformViewer(): Promise<PlatformViewer | null> {
  const user = await getServerUser();
  if (!user?.email) return null;
  // Exact (case-normalised) match, not ILIKE — a user-controlled email used as
  // a LIKE pattern is a privilege-escalation vector. platform_admins IS the
  // operator allowlist, so a service-scope read filtered by the verified email
  // is the gate.
  const rows = await withService((db) =>
    db
      .select({ email: platformAdmins.email, role: platformAdmins.role })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, user.email!.toLowerCase()))
      .limit(1),
  ).catch(() => []);
  const data = rows[0];
  if (!data) return null;
  return {
    email: data.email,
    role: data.role as "superadmin" | "member",
  };
}

export interface PlatformStoreRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  plan_expires_at: string | null; // timed plans — null = indefinite
  /** Comped-plan overlay (docs/comped-plans-spec.md). Carried so the console
   *  shows the EFFECTIVE plan, which is what every gate actually reads. */
  comp_plan: string | null;
  comp_expires_at: string | null;
  custom_domain: string | null;
  created_at: string;
  owner_email: string | null; // superadmin who set the store up (from admins)
  ai_used: number; // included Mink credits consumed in the current plan cycle
  credit_balance: number; // purchased/granted Mink credits remaining
  /** BYO payment gateway state: none = not connected. Never the keys. */
  gateway: "none" | "enabled" | "paused";
}

export interface PlatformOverview {
  totalStores: number;
  activeStores: number;
  paidStores: number;
  newStores30d: number;
  suspendedStores: number;
  emailFailures24h: number;
}

/** Small, uncached operator health snapshot for the console header. */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  const empty: PlatformOverview = {
    totalStores: 0,
    activeStores: 0,
    paidStores: 0,
    newStores30d: 0,
    suspendedStores: 0,
    emailFailures24h: 0,
  };
  if (!(await getPlatformViewer())) return empty;

  try {
    const result = await withService((db) =>
      // Merchants only: previews and theme demos are not stores anybody runs.
      db.execute(sql`
        ${MERCHANT_STORES_CTE}
        select
          (select count(*)::int from merchant_stores) as total_stores,
          (select count(*)::int from merchant_stores where status = 'active') as active_stores,
          (select count(*)::int from merchant_stores
            where plan <> 'free'
              and (plan_expires_at is null or plan_expires_at > now())) as paid_stores,
          (select count(*)::int from merchant_stores
            where created_at >= now() - interval '30 days') as new_stores_30d,
          (select count(*)::int from merchant_stores where status = 'suspended') as suspended_stores,
          (select count(*)::int from email_logs
            where status = 'failed'
              and created_at >= now() - interval '24 hours') as email_failures_24h
      `),
    );
    const row = result.rows[0] as Record<string, number | string> | undefined;
    if (!row) return empty;
    return {
      totalStores: Number(row.total_stores) || 0,
      activeStores: Number(row.active_stores) || 0,
      paidStores: Number(row.paid_stores) || 0,
      newStores30d: Number(row.new_stores_30d) || 0,
      suspendedStores: Number(row.suspended_stores) || 0,
      emailFailures24h: Number(row.email_failures_24h) || 0,
    };
  } catch (error) {
    logError("getPlatformOverview failed", error);
    return empty;
  }
}

// Trim the search term to a sane length (parameterised — no escaping needed).
function sanitize(q: string): string {
  return q.trim().slice(0, 80);
}

/** Slugs of the theme demo stores that exist (operator-only). The store list
 *  no longer includes demos, so the Themes panel asks this instead to know
 *  whether to offer "Seed" or "Reseed" and a live Preview link. */
export async function listDemoStoreSlugs(): Promise<string[]> {
  if (!(await getPlatformViewer())) return [];
  try {
    const rows = await withService((db) =>
      db
        .select({ slug: stores.slug })
        .from(stores)
        .where(
          sql`(${stores.settings} -> 'demo') = 'true'::jsonb and not (${stores.settings} ? 'studioPreview')`,
        ),
    );
    return rows.map((r) => r.slug);
  } catch (error) {
    logError("listDemoStoreSlugs failed", error);
    return [];
  }
}

// Every merchant store on the platform (operator-only; service scope bypasses
// per-store RLS). Theme demos and Studio previews are excluded.
export async function listAllStores(q?: string): Promise<PlatformStoreRow[]> {
  if (!(await getPlatformViewer())) return [];

  const term = sanitize(q ?? "");
  try {
    return await withService(async (db) => {
      // Theme Studio previews and theme demo stores are platform plumbing,
      // not merchants; demos are managed from Themes.
      const conds = [
        merchantStoreCondition,
        ...(term
          ? [
              or(
                ilike(stores.name, `%${term}%`),
                ilike(stores.slug, `%${term}%`),
              )!,
            ]
          : []),
      ];
      const rows = await db
        .select({
          id: stores.id,
          slug: stores.slug,
          name: stores.name,
          status: stores.status,
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
          custom_domain: stores.customDomain,
          created_at: stores.createdAt,
        })
        .from(stores)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(stores.createdAt))
        .limit(500);

      const list = rows.map(
        (s): PlatformStoreRow => ({
          ...s,
          owner_email: null,
          ai_used: 0,
          credit_balance: 0,
          gateway: "none" as const,
        }),
      );
      if (!list.length) return list;

      // Enrich in batch queries (never per-store): owner email, each store's
      // current plan-anchored Mink usage, top-up balance and gateway state.
      const ids = list.map((s) => s.id);
      const owners = await db
        .select({
          store_id: admins.storeId,
          email: admins.email,
          created_at: admins.createdAt,
        })
        .from(admins)
        .where(and(inArray(admins.storeId, ids), eq(admins.role, "superadmin")))
        .orderBy(asc(admins.createdAt));
      const subscriptions = await db
        .select({
          store_id: billingSubscriptions.storeId,
          started_at: billingSubscriptions.currentPeriodStart,
        })
        .from(billingSubscriptions)
        .where(inArray(billingSubscriptions.storeId, ids));
      const startByStore = new Map(
        subscriptions.map((row) => [row.store_id, row.started_at]),
      );
      const periodByStore = new Map(
        ids.map((id) => [
          id,
          minkCreditCycleAt(new Date(), startByStore.get(id)).period,
        ]),
      );
      const usage = await db
        .select({
          store_id: aiUsage.storeId,
          period: aiUsage.period,
          used: aiUsage.used,
        })
        .from(aiUsage)
        .where(
          and(
            inArray(aiUsage.storeId, ids),
            inArray(aiUsage.period, [...new Set(periodByStore.values())]),
          ),
        );
      const credits = await db
        .select({
          store_id: aiCreditBalances.storeId,
          balance: aiCreditBalances.balance,
        })
        .from(aiCreditBalances)
        .where(inArray(aiCreditBalances.storeId, ids));
      const gw = await db
        .select({
          store_id: storePaymentProviders.storeId,
          enabled: storePaymentProviders.enabled,
        })
        .from(storePaymentProviders)
        .where(inArray(storePaymentProviders.storeId, ids));

      // Earliest superadmin per store wins as "owner".
      const ownerByStore = new Map<string, string>();
      for (const o of owners) {
        if (!ownerByStore.has(o.store_id) && o.email)
          ownerByStore.set(o.store_id, o.email);
      }
      const usedByStore = new Map(
        usage
          .filter((row) => periodByStore.get(row.store_id) === row.period)
          .map((row) => [row.store_id, row.used]),
      );
      const creditsByStore = new Map(
        credits.map((c) => [c.store_id, c.balance]),
      );
      const gatewayByStore = new Map(
        gw.map((g) => [
          g.store_id,
          g.enabled ? ("enabled" as const) : ("paused" as const),
        ]),
      );

      for (const s of list) {
        s.owner_email = ownerByStore.get(s.id) ?? null;
        s.ai_used = usedByStore.get(s.id) ?? 0;
        s.credit_balance = creditsByStore.get(s.id) ?? 0;
        s.gateway = gatewayByStore.get(s.id) ?? "none";
      }
      return list;
    });
  } catch (err) {
    console.error("listAllStores:", err instanceof Error ? err.message : err);
    return [];
  }
}

export interface ActionResult {
  success?: boolean;
  error?: string;
  warning?: string;
}

// Suspend / reactivate a store (platform superadmin only). A suspended store
// stops resolving on the storefront (Read stores policy requires status=active).
export async function setStoreStatus(
  storeId: string,
  status: "active" | "suspended",
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change store status." };
  }
  if (!["active", "suspended"].includes(status)) {
    return { error: "Invalid status." };
  }
  try {
    await withService((db) =>
      db.update(stores).set({ status }).where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error("setStoreStatus:", err instanceof Error ? err.message : err);
    return { error: "Could not update the store. Please try again." };
  }
  revalidateTag(STORE_TAG, "max");
  emitEvent({
    type: "platform.store_suspended",
    storeId: null,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "store", id: storeId },
    payload: { status },
  });
  return { success: true };
}

// Set a store's plan (platform superadmin only) — ANY direction, optionally
// time-boxed. Downgrades are soft (existing data is never deleted; creating
// new rows past the smaller plan's caps is what gets blocked — lib/plans.ts).
// `expiresAt` bounds the grant: an ISO timestamp in the future, or null for
// indefinite. Expired plans behave as free immediately (effectivePlan) and are
// durably flipped by /api/cron/plan-expiry. Every change is recorded in the
// append-only plan_events audit log.
export async function setStorePlan(
  storeId: string,
  targetPlan: string,
  opts?: { expiresAt?: string | null },
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change store plans." };
  }
  if (!PLAN_IDS.includes(targetPlan as Plan)) {
    return { error: "Invalid plan." };
  }
  const target = targetPlan as Plan;

  // Free never expires (there is nothing to lapse to); paid plans may carry
  // an expiry, which must parse and lie in the future.
  let expiresAt: string | null = null;
  if (target !== "free" && opts?.expiresAt != null) {
    const parsed = new Date(opts.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return { error: "Invalid expiry date." };
    }
    if (parsed.getTime() <= Date.now()) {
      return { error: "The expiry date must be in the future." };
    }
    expiresAt = parsed.toISOString();
  }

  const storeRows = await withService((db) =>
    db
      .select({
        plan: stores.plan,
        plan_expires_at: stores.planExpiresAt,
        comp_plan: stores.compPlan,
        comp_expires_at: stores.compExpiresAt,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  ).catch(() => []);
  const store = storeRows[0];
  if (!store) return { error: "Store not found." };

  const current = normalizePlan(store.plan);
  if (
    current === target &&
    (store.plan_expires_at ?? null) === (expiresAt ?? null)
  ) {
    return { error: `This store is already on ${PLAN_META[target].name}.` };
  }

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ plan: target, planSource: "comp", planExpiresAt: expiresAt })
        // no-op if the plan changed under us (stale row).
        .where(and(eq(stores.id, storeId), eq(stores.plan, store.plan))),
    );
  } catch (err) {
    console.error("setStorePlan:", err instanceof Error ? err.message : err);
    return { error: "Could not update the plan. Please try again." };
  }

  // Best-effort audit trail — the plan change itself is the source of truth.
  try {
    await withService((db) =>
      db.insert(planEvents).values({
        storeId,
        fromPlan: current,
        toPlan: target,
        source: "operator",
        actor: viewer.email,
        note: expiresAt
          ? `expires ${expiresAt.slice(0, 10)}`
          : target === "free"
            ? null
            : "indefinite",
      }),
    );
  } catch (auditErr) {
    console.error(
      "setStorePlan (audit):",
      auditErr instanceof Error ? auditErr.message : auditErr,
    );
  }

  // Plan gates feature settings (minPlan) — bust the cached store lookups so
  // the store's dashboard + storefront see the new plan immediately.
  revalidateTag(STORE_TAG, "max");

  // Two events, two audiences: the MERCHANT is told their plan changed, and
  // StoreMink operators see it on the platform feed.
  emitEvent({
    type: "plan.changed",
    storeId,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "plan", id: target, label: PLAN_META[target].name },
    payload: { plan: target, note: "Changed by StoreMink" },
  });
  emitEvent({
    type: "platform.plan_changed",
    storeId: null,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "store", id: storeId },
    payload: { plan: target },
  });
  return { success: true };
}

// Grant free Mink credits to a store (platform superadmin only). Goes through
// the same atomic add_ai_credits RPC as purchases, so every grant lands in the
// append-only ai_credit_ledger with the operator's email as the ref.
const MAX_CREDIT_GRANT = 10_000;

export async function grantAiCredits(
  storeId: string,
  amount: number,
  note?: string,
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can grant credits." };
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CREDIT_GRANT) {
    return {
      error: `Credits must be a whole number between 1 and ${MAX_CREDIT_GRANT}.`,
    };
  }

  const storeRows = await withService((db) =>
    db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  ).catch(() => []);
  if (!storeRows[0]) return { error: "Store not found." };

  const noteVal = sanitize(note ?? "").slice(0, 200) || null;
  try {
    await withService((db) =>
      db.execute(
        sql`select add_ai_credits(p_store => ${storeId}, p_delta => ${amount}, p_kind => ${"grant"}, p_ref => ${viewer.email}, p_note => ${noteVal})`,
      ),
    );
  } catch (err) {
    console.error("grantAiCredits:", err instanceof Error ? err.message : err);
    return { error: "Could not grant credits. Please try again." };
  }
  return { success: true };
}

// Per-store audit history for the console drawer: plan changes (plan_events)
// + the AI-credit ledger. Read-only, superadmin-gated like the mutations.
export interface StoreAuditData {
  planEvents: Array<{
    id: string;
    from_plan: string | null;
    to_plan: string;
    source: string;
    actor: string | null;
    note: string | null;
    created_at: string;
  }>;
  creditLedger: Array<{
    id: string;
    delta: number;
    kind: string;
    ref: string | null;
    note: string | null;
    created_at: string;
  }>;
}

export async function getStoreAudit(
  storeId: string,
): Promise<StoreAuditData | null> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") return null;

  try {
    return await withService(async (db) => {
      const planEventRows = await db
        .select({
          id: planEvents.id,
          from_plan: planEvents.fromPlan,
          to_plan: planEvents.toPlan,
          source: planEvents.source,
          actor: planEvents.actor,
          note: planEvents.note,
          created_at: planEvents.createdAt,
        })
        .from(planEvents)
        .where(eq(planEvents.storeId, storeId))
        .orderBy(desc(planEvents.createdAt))
        .limit(30);
      const creditLedgerRows = await db
        .select({
          id: aiCreditLedger.id,
          delta: aiCreditLedger.delta,
          kind: aiCreditLedger.kind,
          ref: aiCreditLedger.ref,
          note: aiCreditLedger.note,
          created_at: aiCreditLedger.createdAt,
        })
        .from(aiCreditLedger)
        .where(eq(aiCreditLedger.storeId, storeId))
        .orderBy(desc(aiCreditLedger.createdAt))
        .limit(30);
      return {
        planEvents: planEventRows as StoreAuditData["planEvents"],
        creditLedger: creditLedgerRows as StoreAuditData["creditLedger"],
      };
    });
  } catch (err) {
    console.error("getStoreAudit:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Any media public URL in Google Cloud Storage (storage.googleapis.com/<bucket>/…).
// Historical GCS media was not always store-prefixed, so scrape every URL from
// the store's rows before they cascade; deleteStorageUrls deletes what is in
// our bucket and counts the rest for the operator. A URL ends at a backslash:
// the rows are scanned as JSON, which writes an HTML attribute's quote as \"
// and a newline as \n, and URL parsing would read that backslash as a slash
// and ask to delete `<path>/`, an object that never exists.
const MEDIA_URL_RE =
  /https?:\/\/[^"'\s)\\]*storage\.googleapis\.com\/[^/"'\s)\\]+\/[^"'\s)\\]+/g;

// Every store-scoped table that can hold an uploaded image (product/variant
// galleries, category tiles, blog covers+bodies, both generations of builder
// sections/chrome, review/return photos, campaign HTML, billing branding,
// colour-card art, customer avatars and the media library itself). Selecting
// all columns + JSON scan means a new media column on one of these tables is
// covered automatically. New uploads are also store-prefixed in GCS, so the
// prefix purge below catches abandoned files that have no row at all.
const MEDIA_TABLES = [
  products,
  productVariants,
  categories,
  blogs,
  blogComments,
  homepageSections,
  storePages,
  storeChrome,
  productReviews,
  orderReturns,
  emailCampaigns,
  cardColors,
  storeBillingSettings,
  mediaAssets,
  users,
];

// PERMANENTLY delete a store and everything belonging to it (platform
// superadmin only). Irreversible. Every store-scoped table FKs stores(id) with
// ON DELETE CASCADE, so one DELETE removes all DB rows, except StoreMink's own
// invoices to the merchant and their payment attempts, which are kept with
// store_id NULL (migration 0243, ON DELETE SET NULL), and its open
// reconciliation items, detached in the same transaction; we additionally purge
// the store's uploaded media, custom-domain control-plane resources, its
// sign-in hosts in Identity Platform's authorized-domain list and login
// accounts that are no longer attached to any other StoreMink role (none of
// those external resources cascade from the stores table).
export async function deleteStore(storeId: string): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can delete a store." };
  }
  // The WholeSip fallback store underpins unresolved-host handling — never let
  // it be deleted from the console.
  if (storeId === FALLBACK_STORE_ID) {
    return { error: "The WholeSip fallback store can't be deleted." };
  }

  const mediaUrls = new Set<string>();
  const authUserIds = new Set<string>();
  const authEmailsById = new Map<string, Set<string>>();
  let customDomain: string | null = null;
  let storeSlug: string | null = null;
  let legacyResendDomainId: string | null = null;
  const addAuthCandidate = (id: string | null, email?: string | null) => {
    if (!id) return;
    authUserIds.add(id);
    if (!email) return;
    const emails = authEmailsById.get(id) ?? new Set<string>();
    emails.add(email.trim().toLowerCase());
    authEmailsById.set(id, emails);
  };
  const scan = (obj: unknown) => {
    for (const m of JSON.stringify(obj ?? "").match(MEDIA_URL_RE) ?? [])
      mediaUrls.add(m);
  };

  try {
    const found = await withService(async (db) => {
      const storeRows = await db
        .select({
          id: stores.id,
          slug: stores.slug,
          settings: stores.settings,
          custom_domain: stores.customDomain,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      if (!storeRows[0]) return null;
      scan(storeRows[0].settings);
      customDomain = storeRows[0].custom_domain;
      storeSlug = storeRows[0].slug;
      const settings = (storeRows[0].settings ?? {}) as Record<string, unknown>;
      legacyResendDomainId =
        typeof settings.resend_domain_id === "string"
          ? settings.resend_domain_id
          : null;

      // Login accounts to delete (Identity Platform). admins.id, users.id and
      // pos_staff.user_id are auth user ids; their rows cascade with the store,
      // so collect the ids before that relationship disappears.
      const staff = await db
        .select({ id: admins.id, email: admins.email })
        .from(admins)
        .where(eq(admins.storeId, storeId));
      const customerRows = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.storeId, storeId));
      const posStaffRows = await db
        .select({ user_id: posStaff.userId, email: posStaff.email })
        .from(posStaff)
        .where(eq(posStaff.storeId, storeId));
      for (const r of staff) addAuthCandidate(r.id, r.email);
      for (const r of customerRows) addAuthCandidate(r.id, r.email);
      for (const r of posStaffRows) addAuthCandidate(r.user_id, r.email);

      // Media URLs referenced anywhere in the store's rows (scanned as JSON so
      // we catch image fields, jsonb arrays AND HTML bodies).
      for (const table of MEDIA_TABLES) {
        const rows = await db
          .select()
          .from(table)
          .where(eq(table.storeId, storeId));
        if (rows.length) scan(rows);
      }
      return true;
    });
    if (!found) return { error: "Store not found." };
  } catch (err) {
    console.error("deleteStore (scan):", err);
    return { error: "Could not delete the store. Please try again." };
  }

  // Delete the store — FK ON DELETE CASCADE wipes every store-scoped row except
  // StoreMink's own invoices (below).
  //
  // ★★ WITH THE CHECKS DEFERRED TO COMMIT. order_items → products and the
  // Mink publication/campaign → approval/draft foreign keys refuse to let a
  // referenced row go while a reference exists, and PostgreSQL runs a
  // statement's cascades in queue order — products before orders — so the
  // check fired against order_items rows the same statement was about to
  // remove, and no store that had ever taken an order could be purged
  // (migration 20261007_0172). Deferring moves those checks to COMMIT, after
  // every cascade has run; everywhere else the constraints keep their
  // immediate behaviour, because only this transaction asks.
  //
  // ★★ AND WITH ITS OWN STATEMENT LIMIT, 5 MINUTES, NOT THE POOL'S 30 S
  // (lib/db/client.ts). This one DELETE is every row the store owns. Measured
  // on storemink_local (2026-10-24, rolled back): a store with 200,305
  // orders, 400,516 order lines, 211,438 storefront events and 20,025
  // customers took 13.9 s with storefront_events.order_id indexed, so on the
  // shared-core production database a large store would pass 30 s and could
  // never be purged. SET LOCAL ends with this transaction, so no other
  // statement gets the longer limit, and a runaway still stops well inside
  // Cloud Run's 20-minute request. (The checks deferred to COMMIT are not
  // timed by Postgres at all; they took 71 ms here.)
  // ⚠ That index does not exist yet: each order then costs one full scan of
  // storefront_events (16.8 ms per order at 211k events, measured), so a
  // store with tens of thousands of orders can pass even 5 minutes, and the
  // operator sees "Could not delete the store" with nothing deleted.
  //
  // ★★ STOREMINK'S OWN INVOICES TO THIS MERCHANT ARE KEPT (owner's decision,
  // 25 Oct 2026). GST requires them, the series is gapless, and Terms section
  // 13 and Privacy section 7 say so: billing_invoices and
  // billing_payment_attempts are ON DELETE SET NULL (migration 0243), so the
  // cascade leaves every issued invoice, its lines and its attempts in place
  // with store_id NULL and the parties it recorded when it was issued.
  // ★ A DRAFT IS NOT AN INVOICE (no number, never issued), so drafts are
  // deleted here, first, in this transaction, and their lines and attempts go
  // with them. One kind of draft is kept: one with a payment that may have
  // reached the gateway (an order id, and not failed or cancelled), because
  // that attempt is the only record of money StoreMink may have taken;
  // reconciliation flags it if the payment was captured
  // (lib/billing/reconcile.ts). ★ An issued invoice cannot be deleted at all
  // (billing_invoices_keep_issued, migration 0245), so a wrong predicate here
  // fails the purge instead of removing a GST document.
  //
  // ★ OPEN MONEY QUESTIONS ARE KEPT TOO. An open or "needs chasing"
  // reconciliation item can be the only record of a payment (an amount
  // mismatch's observed amount lives nowhere else), so it is detached
  // (store_id NULL, marked storeDeleted with the store's name) instead of
  // cascading. A closed one is history and goes with the store.
  // ★ A PAID AI CREDIT PURCHASE WHOSE RECEIPT NEVER ISSUED has no invoice to
  // keep and no payment attempt, and its purchase row cascades, so it is filed
  // as an open orphan_payment item first: the payment ids and the amount
  // survive for whoever settles the missing receipt. ⚠ A PENDING purchase is
  // not filed (an abandoned checkout is never reaped and would bury the
  // queue), and a purchase row behind an ISSUED receipt still cascades: the
  // kept invoice no longer links to its Razorpay ids. Keeping
  // ai_credit_purchases needs a migration (owner's decision).
  let unissuedReceipts = 0;
  try {
    await withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5min'`);
      await db.execute(sql`set constraints all deferred`);
      await db
        .update(billingReconciliationItems)
        .set({
          storeId: null,
          detail: sql`${billingReconciliationItems.detail} || jsonb_build_object('storeDeleted', true, 'storeName', (select s.name from public.stores s where s.id = ${storeId}))`,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(billingReconciliationItems.storeId, storeId),
            inArray(billingReconciliationItems.status, [
              "open",
              "manual_review",
            ]),
          ),
        );
      const filed = await db.execute(sql`
        insert into public.billing_reconciliation_items
          (store_id, kind, status, provider_payment_id, provider_order_id,
           expected_paise, detail)
        select null, 'orphan_payment', 'open', p.rzp_payment_id, p.rzp_order_id,
               p.amount_inr::bigint * 100,
               jsonb_build_object(
                 'note', 'AI credit purchase paid, receipt never issued',
                 'storeDeleted', true,
                 'storeName', s.name,
                 'credits', p.credits)
          from public.ai_credit_purchases p
          join public.stores s on s.id = p.store_id
          join public.billing_invoices i on i.id = p.invoice_id
         where p.store_id = ${storeId}
           and p.status = 'paid'
           and i.finalized_at is null
        on conflict do nothing
        returning id`);
      unissuedReceipts = filed.rows.length;
      await db
        .delete(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            isNull(billingInvoices.finalizedAt),
            sql`not exists (select 1 from public.billing_payment_attempts a where a.invoice_id = ${billingInvoices.id} and a.provider_order_id is not null and a.state not in ('failed', 'cancelled'))`,
          ),
        );
      await db.delete(stores).where(eq(stores.id, storeId));
    });
  } catch (err) {
    // A Drizzle error's `message` is only "Failed query: …"; the reason is on
    // `cause` (the §15b lesson).
    console.error(
      "deleteStore:",
      err instanceof Error ? (err.cause ?? err.message) : err,
    );
    return { error: "Could not delete the store. Please try again." };
  }

  // Cleanup of things that DON'T cascade from stores. The individual helpers
  // are idempotent, and any partial failure is surfaced to the operator instead
  // of silently pretending the purge was complete.
  const cleanupFailures: string[] = [];

  // ★ THE SUBDOMAIN'S OWN SIGN-IN HOST, removed straight after the row
  // delete. Phone sign-in needs `{slug}.{root}` listed EXACTLY
  // (lib/auth/store-auth-hosts.ts), so every store has its own
  // authorizedDomains entry and nothing else removes it. ★ BEFORE the media and
  // certificate cleanup, which can take minutes: the slug is free from the
  // moment the row is gone, and a store re-created on it in that window would
  // have its new host removed. removeAuthorizedHosts also skips a host a store
  // still serves, re-read just before its write. Settings are left out on
  // purpose, so no demo/preview flag can skip the removal (a host that was
  // never listed costs one read); a local dev root yields no host at all. The
  // custom domain's hosts go with cleanupDetachedDomain below.
  const authHosts = storeSlug
    ? storeAuthHosts({ slug: storeSlug }, ROOT_DOMAIN)
    : [];
  if (authHosts.length > 0) {
    const deauth = await removeAuthorizedHosts(authHosts, ROOT_DOMAIN).catch(
      (err): { error: string } => ({
        error: err instanceof Error ? err.message : "remove threw",
      }),
    );
    if (deauth.error) {
      logError("deleteStore (authorized host)", deauth.error, {
        storeId,
        hosts: authHosts,
      });
      cleanupFailures.push(
        `Identity Platform authorized domain ${authHosts.join(", ")}`,
      );
    }
  }

  const urlCleanup = await deleteStorageUrls(Array.from(mediaUrls));
  if ((urlCleanup?.failed ?? 0) > 0) {
    cleanupFailures.push(`${urlCleanup.failed} referenced media object(s)`);
  }
  if ((urlCleanup?.unmanaged ?? 0) > 0) {
    cleanupFailures.push(
      `${urlCleanup.unmanaged} legacy/external media object(s) not managed by GCS`,
    );
  }
  const prefixCleanup = await gcsDeletePrefix(storeStoragePrefix(storeId));
  if (prefixCleanup.error || prefixCleanup.failed > 0) {
    cleanupFailures.push("store media prefix");
  }
  // WhatsApp chat media lives in the private bucket under the same prefix.
  if (gcsPrivateConfigured) {
    const privateCleanup = await gcsDeletePrefix(
      storeStoragePrefix(storeId),
      "private",
    );
    if (privateCleanup.error || privateCleanup.failed > 0) {
      cleanupFailures.push("store private media prefix");
    }
  }

  if (customDomain || legacyResendDomainId) {
    try {
      const domainCleanup = await cleanupDetachedDomain(
        customDomain,
        "deleteStore",
        legacyResendDomainId,
      );
      cleanupFailures.push(...domainCleanup.failures);
    } catch (err) {
      logError("deleteStore (custom domain cleanup)", err, {
        storeId,
        domain: customDomain,
      });
      cleanupFailures.push("custom-domain resources");
    }
  }

  // A Firebase identity may also be a customer, admin or POS operator in a
  // different store, or a platform operator. Delete only identities left with
  // no StoreMink role after the store cascade; otherwise deleting one tenant
  // would break access to another. A kept login is NAMED in the result: its
  // email cannot sign up as new, and the operator who deleted the store would
  // otherwise assume it could.
  const retainedAuthIds = new Set<string>();
  const keptInUse: string[] = [];
  if (authUserIds.size > 0 && !isFirebaseAdminConfigured()) {
    cleanupFailures.push("Identity Platform is not configured");
  } else if (authUserIds.size > 0) {
    try {
      const candidates = new Map<string, ReadonlySet<string>>();
      for (const id of authUserIds) {
        candidates.set(id, authEmailsById.get(id) ?? new Set<string>());
      }
      for (const id of await authIdsInUse(candidates)) {
        retainedAuthIds.add(id);
        keptInUse.push([...(authEmailsById.get(id) ?? [])][0] ?? id);
      }
    } catch (err) {
      // Fail safe: if the cross-store reference check is unavailable, retain
      // every login. Deleting a possibly-shared identity is worse than leaving
      // an orphan for an operator to retry.
      logError("deleteStore (auth reference check)", err, { storeId });
      cleanupFailures.push("login-account reference check");
      for (const id of authUserIds) retainedAuthIds.add(id);
    }

    for (const id of authUserIds) {
      if (retainedAuthIds.has(id)) continue;
      try {
        await deleteAuthUser(id);
      } catch (err) {
        logError("deleteStore (auth user)", err, { storeId, userId: id });
        cleanupFailures.push(`login account ${id}`);
      }
    }
  }

  revalidateTag(STORE_TAG, "max");
  const notes: string[] = [];
  if (cleanupFailures.length) {
    notes.push(
      `The store data was deleted, but cleanup still needs attention: ${cleanupFailures.join(
        ", ",
      )}.`,
    );
  }
  if (keptInUse.length) {
    notes.push(
      `Kept ${keptInUse.length === 1 ? "1 login" : `${keptInUse.length} logins`} that another store or the operator console still uses (${keptInUse.join(
        ", ",
      )}). Signing up with ${keptInUse.length === 1 ? "that email" : "those emails"} reuses the existing account.`,
    );
  }
  if (unissuedReceipts > 0) {
    notes.push(
      `${unissuedReceipts === 1 ? "1 paid AI credit purchase has" : `${unissuedReceipts} paid AI credit purchases have`} no issued receipt. ${unissuedReceipts === 1 ? "It is" : "They are"} now in Billing & tax > Reconciliation, so the payment is not lost.`,
    );
  }
  return notes.length
    ? { success: true, warning: notes.join(" ") }
    : { success: true };
}

// ---------------------------------------------------------------------------
// Platform operators (RBAC) — manage who can operate Storemink.
// ---------------------------------------------------------------------------

export interface PlatformAdminRow {
  id: string;
  email: string;
  role: "superadmin" | "member";
  created_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The operator roster (any operator can view).
export async function listPlatformAdmins(): Promise<PlatformAdminRow[]> {
  if (!(await getPlatformViewer())) return [];
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: platformAdmins.id,
          email: platformAdmins.email,
          role: platformAdmins.role,
          created_at: platformAdmins.createdAt,
        })
        .from(platformAdmins)
        .orderBy(asc(platformAdmins.createdAt)),
    );
    return rows as PlatformAdminRow[];
  } catch (err) {
    console.error("listPlatformAdmins:", err);
    return [];
  }
}

async function requireSuperadmin(): Promise<PlatformViewer | null> {
  const viewer = await getPlatformViewer();
  return viewer?.role === "superadmin" ? viewer : null;
}

// Count of platform superadmins (last-superadmin guards).
async function platformSuperadminCount(): Promise<number> {
  const rows = await withService((db) =>
    db
      .select({ role: platformAdmins.role })
      .from(platformAdmins)
      .where(eq(platformAdmins.role, "superadmin")),
  ).catch(() => []);
  return rows.length;
}

// Add (or re-role) a platform operator by email. They're recognised on their
// next login — no account needs to exist yet.
export async function invitePlatformAdmin(
  email: string,
  role: "superadmin" | "member",
): Promise<ActionResult> {
  const me = await requireSuperadmin();
  if (!me) return { error: "Only a platform superadmin can add operators." };
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { error: "Enter a valid email." };
  if (!["superadmin", "member"].includes(role))
    return { error: "Invalid role." };

  try {
    await withService((db) =>
      db
        .insert(platformAdmins)
        .values({ email: clean, role })
        .onConflictDoUpdate({ target: platformAdmins.email, set: { role } }),
    );
  } catch (err) {
    if (isUniqueViolation(err))
      return { error: "That operator already exists." };
    console.error(
      "invitePlatformAdmin:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not add the operator. Please try again." };
  }
  return { success: true };
}

export async function updatePlatformAdminRole(
  id: string,
  role: "superadmin" | "member",
): Promise<ActionResult> {
  if (!(await requireSuperadmin()))
    return { error: "Only a platform superadmin can change roles." };

  // Don't allow demoting the last remaining superadmin.
  if (role === "member") {
    const targetRows = await withService((db) =>
      db
        .select({ role: platformAdmins.role })
        .from(platformAdmins)
        .where(eq(platformAdmins.id, id))
        .limit(1),
    ).catch(() => []);
    if (targetRows[0]?.role === "superadmin") {
      if ((await platformSuperadminCount()) <= 1)
        return { error: "Can't demote the last superadmin." };
    }
  }

  try {
    await withService((db) =>
      db.update(platformAdmins).set({ role }).where(eq(platformAdmins.id, id)),
    );
  } catch {
    return { error: "Could not update the operator." };
  }
  return { success: true };
}

export async function removePlatformAdmin(id: string): Promise<ActionResult> {
  if (!(await requireSuperadmin()))
    return { error: "Only a platform superadmin can remove operators." };

  const targetRows = await withService((db) =>
    db
      .select({ role: platformAdmins.role })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, id))
      .limit(1),
  ).catch(() => []);
  if (targetRows[0]?.role === "superadmin") {
    if ((await platformSuperadminCount()) <= 1)
      return { error: "Can't remove the last superadmin." };
  }

  try {
    await withService((db) =>
      db.delete(platformAdmins).where(eq(platformAdmins.id, id)),
    );
  } catch {
    return { error: "Could not remove the operator." };
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Theme demo stores — one real store per theme (slug demo-{themeId}, marked
// settings.demo) that the signup picker's Preview button opens. Re-seedable:
// applyTheme with reset:true wipes the demo's catalog/pages/menus and applies
// the theme fresh, so demos always show the theme's pristine state. No admins
// row is created — nobody logs into a demo store.
// ---------------------------------------------------------------------------

export interface SeedDemoResult {
  success?: boolean;
  error?: string;
  slug?: string;
  warnings?: string[];
}

export async function seedDemoStore(themeId: string): Promise<SeedDemoResult> {
  if (!(await requireSuperadmin())) {
    return { error: "Only a platform superadmin can seed demo stores." };
  }
  const theme = await resolveThemeDefinition(themeId);
  if (theme.id !== themeId) {
    return { error: `Unknown theme "${themeId}".` };
  }

  const slug = theme.demo.slug;

  // Create the store row if missing, or bring its name up to date.
  let storeId: string | undefined;
  try {
    storeId = (await withService((db) => upsertDemoStoreRow(db, theme)))
      .storeId;
  } catch (err) {
    if (err instanceof NotADemoStoreError) return { error: err.message };
    console.error("seedDemoStore (insert):", err);
    return { error: "Could not create the demo store." };
  }

  const result = await applyTheme(storeId, theme.id, {
    publish: true,
    reset: true,
    // A demo store IS the showcase — its whole job is to look like a finished
    // shop, so its sample catalogue must be live. Real merchant stores seed
    // these as drafts (see applyTheme's publishSampleProducts).
    publishSampleProducts: true,
  });

  revalidateTag(STORE_TAG, "max");
  if (!result.success) {
    return {
      success: true,
      slug,
      warnings: result.errors,
    };
  }
  return { success: true, slug };
}

// ── Plan pricing (platform superadmin) ──────────────────────────────────────
// Prices were compiled into lib/plans.ts, so moving one meant a deploy. These
// let an operator set them from the console; lib/plans/pricing.ts folds the
// stored rows onto the code defaults, so an empty table behaves exactly as
// before and a failed read falls back to the constants rather than to nothing.
//
// EXISTING SUBSCRIBERS ARE NOT REPRICED. lib/payments/subscription.ts keys its
// Razorpay plan cache on (plan, period, amountPaise), so a new price mints a
// NEW Razorpay plan and anyone already subscribed keeps the amount they agreed
// to. That grandfathering is deliberate.

/** A sane ceiling. Guards a typo — a trailing zero on a price page is the kind
 *  of mistake that is only noticed by the first person who refuses to pay. */
const MAX_PLAN_PRICE_INR = 500_000;

export interface PlanPriceInput {
  plan: string;
  monthlyInr: number;
  yearlyInr: number;
  /** Struck-through list price. Null / 0 / blank clears the offer. */
  baseMonthlyInr: number | null;
  baseYearlyInr: number | null;
}

export interface MinkCreditPackInput {
  id: string;
  name: string;
  credits: number;
  priceInr: number;
  popular: boolean;
}

/**
 * Replace the whole Mink credit-pack catalogue (migration 0116).
 *
 * ★ THE WHOLE LIST, NOT ONE PACK AT A TIME. The operator edits a table and
 * presses Save once; reconciling here means the highlighted pack, the order and
 * a removal all commit together, so the catalogue a merchant sees is never a
 * half-applied edit. `sort_order` is the array index, so the rows ARE the order.
 *
 * ★ Deleting a pack is safe and does not touch history: ai_credit_purchases
 * snapshots `credits` and `amount_inr`, `pack_id` carries no foreign key, and
 * confirmCreditPurchase grants from that row rather than re-reading the pack.
 * A merchant who had the old card on screen gets "Unknown credit pack" and
 * picks again — recoverable, unlike being charged a price nobody set.
 */
export async function saveMinkCreditPacks(
  input: MinkCreditPackInput[],
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change pricing." };
  }
  if (!Array.isArray(input)) {
    return { error: "Submit the full list of credit packs." };
  }
  const packs: CreditPack[] = input.map((row) => ({
    id: typeof row?.id === "string" ? row.id.trim() : "",
    name: typeof row?.name === "string" ? row.name.trim() : "",
    credits: Number(row?.credits),
    priceInr: Number(row?.priceInr),
    popular: row?.popular === true,
  }));
  // One rule set, shared with the form — see validateCreditPacks.
  const problems = validateCreditPacks(packs);
  if (problems.length) {
    const first = problems[0];
    return {
      error:
        first.index >= 0
          ? `Pack ${first.index + 1}: ${first.message}`
          : first.message,
    };
  }

  try {
    await withService(async (db) => {
      const keep = packs.map((pack) => pack.id);
      // ⚠ Clear `popular` FIRST. The partial unique index allows one true row,
      // so moving the highlight from pack A to pack B in a single pass would
      // collide the moment B is written while A still holds it.
      await db.update(minkCreditPacks).set({ popular: false });
      await db
        .delete(minkCreditPacks)
        .where(notInArray(minkCreditPacks.id, keep));
      for (const [index, pack] of packs.entries()) {
        await db
          .insert(minkCreditPacks)
          .values({
            id: pack.id,
            name: pack.name,
            credits: pack.credits,
            priceInr: pack.priceInr,
            popular: pack.popular === true,
            sortOrder: index,
            updatedBy: viewer.email ?? null,
          })
          .onConflictDoUpdate({
            target: minkCreditPacks.id,
            set: {
              name: pack.name,
              credits: pack.credits,
              priceInr: pack.priceInr,
              popular: pack.popular === true,
              sortOrder: index,
              updatedBy: viewer.email ?? null,
              updatedAt: new Date().toISOString(),
            },
          });
      }
    });
  } catch (error) {
    logError("saveMinkCreditPacks failed", error);
    return { error: "Couldn't save the credit packs. Please try again." };
  }
  revalidatePath("/dashboard/plans");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Included Mink credits per plan (migration 0115).
//
// The only plan LIMIT an operator can move without a deploy. Everything else in
// PLAN_LIMITS decides what the code must DO — a product cap, a feature flag —
// while this is a number the same code enforces either way, and it is the one
// merchants ask to have raised.
// ---------------------------------------------------------------------------

/** Bound on a single plan's included allowance. High enough for an enterprise
 *  grant, low enough that a slipped digit is refused rather than handing a tier
 *  an effectively unmetered pool. Mirrored by the database CHECKs. */
const MAX_PLAN_ALLOWANCE = 100_000;

export interface PlanAllowanceInput {
  plan: string;
  includedCredits: number;
}

export async function savePlanCreditAllowances(
  input: PlanAllowanceInput[],
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change allowances." };
  }
  const ids = PLAN_IDS as readonly string[];
  if (
    !Array.isArray(input) ||
    input.length !== ids.length ||
    new Set(input.map((row) => row.plan)).size !== ids.length ||
    input.some((row) => !ids.includes(row.plan))
  ) {
    return { error: "Submit one allowance for each plan." };
  }
  for (const row of input) {
    if (
      !Number.isInteger(row.includedCredits) ||
      row.includedCredits < 1 ||
      row.includedCredits > MAX_PLAN_ALLOWANCE
    ) {
      return {
        error: `${row.plan}: included credits must be a whole number between 1 and ${MAX_PLAN_ALLOWANCE}.`,
      };
    }
  }

  try {
    await withService(async (db) => {
      for (const row of input) {
        await db
          .insert(minkPlanAllowances)
          .values({
            plan: row.plan,
            includedCredits: row.includedCredits,
            // ⚠ The legacy pair is still NOT NULL and the revision this rolls
            // out over still reads it, so both are written to the same number
            // until the contract migration drops them. Writing only the new
            // column would fail the insert outright.
            generationsPerMonth: row.includedCredits,
            creditsPerMonth: row.includedCredits,
            updatedBy: viewer.email ?? null,
          })
          .onConflictDoUpdate({
            target: minkPlanAllowances.plan,
            set: {
              includedCredits: row.includedCredits,
              generationsPerMonth: row.includedCredits,
              creditsPerMonth: row.includedCredits,
              updatedBy: viewer.email ?? null,
              updatedAt: new Date().toISOString(),
            },
          });
      }
    });
  } catch (error) {
    logError("savePlanCreditAllowances failed", error);
    return { error: "Couldn't save Mink allowances. Please try again." };
  }
  // The public pricing table and both console lists read through the cached
  // loader — without this the change would not show until the window lapsed,
  // while the quota gate (live) enforced it immediately.
  bustPlanAllowances();
  revalidatePath("/platform");
  revalidatePath("/dashboard/plans");
  return { success: true };
}

export async function getPlanPricingForConsole(): Promise<
  | { pricing: PlanPricing; extraLocation: ExtraLocationPricing }
  | { error: string }
> {
  const viewer = await getPlatformViewer();
  if (!viewer) return { error: "Not authorized." };
  // Live, not cached: an operator editing prices must see what is stored, not
  // what the public page happens to be serving.
  const [pricing, extraLocation] = await Promise.all([
    getPlanPricingLive(),
    getExtraLocationPricingLive(),
  ]);
  return { pricing, extraLocation };
}

export async function savePlanPricing(
  input: PlanPriceInput[],
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change pricing." };
  }
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "Nothing to save." };
  }

  const rows: {
    plan: string;
    monthlyInr: number;
    yearlyInr: number;
    baseMonthlyInr: number | null;
    baseYearlyInr: number | null;
    updatedBy: string | null;
  }[] = [];

  for (const p of input) {
    // The metered-location add-on is priced through this same panel (roadmap
    // Step 5). It is a legal key here but NOT a tier — lib/plans/pricing.ts
    // keeps it out of the tier map so it can never render as a fourth pricing
    // card, and it has no struck-through price because it has no card.
    const isAddon = p.plan === EXTRA_LOCATION_KEY;
    if (!isAddon && !(PLAN_IDS as readonly string[]).includes(p.plan)) {
      return { error: `Unknown plan: ${p.plan}` };
    }
    const num = (v: unknown, label: string): number | { error: string } => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_PLAN_PRICE_INR) {
        return {
          error: `${label} must be a whole number between 0 and ${MAX_PLAN_PRICE_INR}.`,
        };
      }
      return n;
    };
    const monthly = num(p.monthlyInr, `${p.plan} monthly price`);
    if (typeof monthly !== "number") return monthly;
    const yearly = num(p.yearlyInr, `${p.plan} yearly price`);
    if (typeof yearly !== "number") return yearly;

    // A blank or zero base means "no offer running" — not a free list price.
    // Forced null for the add-on: a strike-through with nothing to render it on
    // is a stored value that can only ever mislead whoever reads the table next.
    const baseM = isAddon
      ? null
      : p.baseMonthlyInr === null || Number(p.baseMonthlyInr) === 0
        ? null
        : num(p.baseMonthlyInr, `${p.plan} base monthly price`);
    if (baseM !== null && typeof baseM !== "number") return baseM;
    const baseY = isAddon
      ? null
      : p.baseYearlyInr === null || Number(p.baseYearlyInr) === 0
        ? null
        : num(p.baseYearlyInr, `${p.plan} base yearly price`);
    if (baseY !== null && typeof baseY !== "number") return baseY;

    // The DB has a CHECK for this too; catching it here gives the operator a
    // sentence instead of a constraint violation.
    if (baseM !== null && baseM < monthly) {
      return {
        error: `${p.plan}: the struck-through price must be at least the price you charge.`,
      };
    }
    if (baseY !== null && baseY < yearly) {
      return {
        error: `${p.plan}: the struck-through yearly price must be at least the yearly price.`,
      };
    }

    rows.push({
      plan: p.plan,
      monthlyInr: monthly,
      yearlyInr: yearly,
      baseMonthlyInr: baseM,
      baseYearlyInr: baseY,
      updatedBy: viewer.email ?? null,
    });
  }

  try {
    await withService(async (db) => {
      for (const r of rows) {
        await db
          .insert(planPrices)
          .values(r)
          .onConflictDoUpdate({
            target: planPrices.plan,
            set: {
              monthlyInr: r.monthlyInr,
              yearlyInr: r.yearlyInr,
              baseMonthlyInr: r.baseMonthlyInr,
              baseYearlyInr: r.baseYearlyInr,
              updatedBy: r.updatedBy,
              updatedAt: new Date().toISOString(),
            },
          });
      }
    });
  } catch (error) {
    logError("savePlanPricing failed", error);
    return { error: "Couldn't save pricing. Please try again." };
  }

  // Public pages read through a cached loader — without this the change would
  // not show until the 5-minute window lapsed, which is not "real time".
  bustPlanPricing();
  revalidatePath("/platform");
  revalidatePath("/platform/pos");
  revalidatePath("/dashboard/plans");
  return { success: true };
}

// ---------------------------------------------------------------------------
// StoreMink's OWN tax identity (§34).
//
// ★ Operator-managed, not merchant-facing and not a config file: it decides what
// a GST tax invoice says, and it changes on a business timetable (the day a GSTIN
// is issued) rather than a deploy one.
// ---------------------------------------------------------------------------

export async function getTaxSettings(): Promise<PlatformTaxSettings | null> {
  const viewer = await getPlatformViewer();
  if (!viewer) return null;
  return getPlatformTaxSettings();
}

export async function saveTaxSettings(
  input: TaxSettingsInput,
): Promise<ActionResult> {
  // ★ SUPERADMIN, matching plan pricing. Switching tax on changes what every
  // merchant is charged from the next invoice onward, and the GSTIN it names is
  // the platform's own tax identity.
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change tax settings." };
  }
  if (!input || typeof input !== "object") {
    return { error: "Nothing to save." };
  }

  const saved = await savePlatformTaxSettings(input, viewer.email ?? null);
  if (!saved.ok) return { error: saved.error };

  // Invoices read this at build time through loadTaxContext, which is uncached —
  // so there is no tag to bust. Revalidating the console page keeps the form in
  // step with what was stored (the GSTIN is upper-cased, the rate rounded).
  revalidatePath("/dashboard/billing");
  return { success: true };
}

// ---------------------------------------------------------------------------
// The reconciliation queue (§34).
//
// ★ Money discrepancies the sweep found and could not decide: an amount that
// differs from what we asked for, a payment that maps to no store. Recorded by
// `lib/billing/reconcile.ts`; closed here, by a human.
// ---------------------------------------------------------------------------

export async function getReconciliationQueue(
  status?: unknown,
): Promise<ReconciliationItem[]> {
  const viewer = await getPlatformViewer();
  if (!viewer) return [];
  const s =
    status === "resolved" || status === "ignored" || status === "manual_review"
      ? status
      : "open";
  return listReconciliationItems({ status: s });
}

export async function getOpenReconciliationCount(): Promise<number> {
  const viewer = await getPlatformViewer();
  if (!viewer) return 0;
  return countOpenReconciliationItems();
}

/**
 * Close one item.
 *
 * ★★ THIS MOVES NO MONEY. It records that an operator looked and what they
 * decided — refunding a difference, issuing a credit, or deciding it does not
 * matter all happen elsewhere, deliberately. Any operator may do it (it is a
 * note, not a payment) and WHO is recorded.
 */
export async function closeReconciliationItem(
  id: unknown,
  status: unknown,
  note: unknown,
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (!viewer) return { error: "You don't have permission to do this." };
  if (typeof id !== "string" || !id) return { error: "Unknown item." };
  if (
    status !== "resolved" &&
    status !== "ignored" &&
    status !== "manual_review"
  ) {
    return { error: "Pick an outcome." };
  }

  const done = await resolveReconciliationItem({
    id,
    status,
    note: typeof note === "string" ? note : "",
    actor: viewer.email ?? null,
  });
  if (!done.ok) return { error: done.error };

  revalidatePath("/dashboard/billing/reconciliation");
  return { success: true };
}
