import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { parseHost } from "@/lib/store/host";
import { PLAN_LIMITS, effectivePlan } from "@/lib/plans";
import { studioPreviewMarker } from "@/lib/theme-studio/preview-store";

// Re-exported so existing importers (and resolve.test.ts) keep working.
export { parseHost, type HostKind } from "@/lib/store/host";

// ---------------------------------------------------------------------------
// Tenant resolution.
//
// Every request belongs to exactly one store. We resolve it from the request's
// Host header:
//   acme.storemink.com        -> store with slug "acme"
//   shop.acme.com         -> store whose custom_domain = "shop.acme.com"
//   storemink.com / app.*     -> the platform itself (no store)
//   localhost / *.vercel  -> the platform (dev/preview)
//
// During the single-tenant period (only WholeSip exists, served at the root /
// localhost), `getCurrentStore()` falls back to WholeSip so the site renders
// exactly as it does today. Once subdomains go live, the same code resolves
// real stores with no further change.
// ---------------------------------------------------------------------------

export interface Store {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  /** Timed plans: ISO timestamp the plan lapses (null = indefinite). Resolve
   *  entitlements via effectivePlan(store), never raw `plan`. */
  plan_expires_at: string | null;
  /** The comped-plan OVERLAY (docs/comped-plans-spec.md). Separate from `plan`
   *  above, which is the PAID entitlement — `effectivePlan` resolves the two by
   *  rank, so a comp can only ever raise and its expiry needs no revert. */
  comp_plan: string | null;
  comp_expires_at: string | null;
  custom_domain: string | null;
  settings: Record<string, unknown>;
}

// The fallback store (the legacy "store #1"). Matches the fixed id seeded in
// multitenant_01_schema.sql. Never-null fallback for dashboard/action callers
// when a host maps to no store; the storefront never relies on it (it 404s).
export const FALLBACK_STORE_ID = "a0000000-0000-4000-8000-000000000001";

// Cache tag for store lookups — call `revalidateTag(STORE_TAG)` after a store
// is created or its settings/domain change.
export const STORE_TAG = "stores";

// Aliased select preserving the snake_case Store shape callers expect.
const STORE_COLUMNS = {
  id: stores.id,
  slug: stores.slug,
  name: stores.name,
  status: stores.status,
  plan: stores.plan,
  plan_expires_at: stores.planExpiresAt,
  comp_plan: stores.compPlan,
  comp_expires_at: stores.compExpiresAt,
  custom_domain: stores.customDomain,
  settings: stores.settings,
};

// Request-scoped memoization keeps brand, settings and host ownership current
// across Cloud Run instances. Errors and missing hosts retry on the next
// request; a newly created store never waits for a cached negative lookup.
class StoreHostMiss extends Error {
  constructor() {
    super("STORE_HOST_MISS");
    this.name = "StoreHostMiss";
  }
}

const lookupStoreByHost = cache(async (host: string): Promise<Store | null> => {
  const kind = parseHost(host);
  if (kind.type === "platform") return null;

  const rows = await withAnon((db) =>
    db
      .select(STORE_COLUMNS)
      .from(stores)
      .where(
        and(
          eq(stores.status, "active"),
          kind.type === "store-subdomain"
            ? eq(stores.slug, kind.slug)
            : eq(stores.customDomain, kind.domain),
        ),
      )
      .limit(1),
  );
  const store = (rows[0] as Store | undefined) ?? null;
  if (!store) throw new StoreHostMiss();

  // A custom domain must clear BOTH gates before we serve on it. Store
  // subdomains are inherently ours and need neither.
  if (store && kind.type === "custom-domain") {
    // (1) Proven owned. Otherwise a store could pre-claim a domain it does
    // not control, and we would serve its content on someone else's address.
    if (store.settings?.custom_domain_verified !== true)
      throw new StoreHostMiss();

    // (2) Still entitled. Custom domains are a Pro feature, and the plan can
    // lapse long after the domain was verified — effectivePlan() is what
    // makes an expired timed plan read as free here rather than as whatever
    // `plan` still says. Serving is the enforcement point ON PURPOSE: gating
    // only the dashboard would let a store connect on Pro, drop to free, and
    // keep the benefit forever.
    if (!PLAN_LIMITS[effectivePlan(store)].customDomain)
      throw new StoreHostMiss();
  }
  return store;
});

// Request-memoized store lookup by id — used for the WholeSip fallback. (RLS mirrors the
// old anon client: only active stores are visible without an identity.)
export const lookupStoreById = cache(
  async (id: string): Promise<Store | null> => {
    // Same rule as lookupStoreByHost: never swallow a DB error into a cached
    // null. Let it throw (uncached); getCurrentStore catches it below.
    const rows = await withAnon((db) =>
      db.select(STORE_COLUMNS).from(stores).where(eq(stores.id, id)).limit(1),
    );
    return (rows[0] as Store | undefined) ?? null;
  },
);

// A Theme Studio preview store (lib/theme-studio/preview-store.ts) resolves only
// for a request carrying its preview grant; for anyone else its host is as
// unknown as an unclaimed subdomain. The host lookup above is request-memoized —
// the grant is per request, so it is checked AFTER the cache, never inside it.
// Dynamically imported so the ordinary request path never loads the Studio's
// server modules: the marker check is the only cost for every other store.
async function withStudioPreviewGate(store: Store): Promise<Store | null> {
  const marker = studioPreviewMarker(store.settings);
  if (!marker) return store;
  const { studioPreviewAllowed } =
    await import("@/lib/theme-studio/preview-access");
  return (await studioPreviewAllowed(store.id, marker.versionId))
    ? store
    : null;
}

// Resolve the store for the current request's Host, or null when the host
// doesn't map to a real active store. Use this at the STOREFRONT render
// boundary (the (storefront) layout) so an unclaimed subdomain / unknown
// custom domain renders a proper "store not found" 404 instead of silently
// impersonating another store. (Internal callers that must always have a
// store id use getCurrentStore()/getCurrentStoreId() below.)
export async function getCurrentStoreOrNull(): Promise<Store | null> {
  const headersList = await headers();
  const host = headersList.get("x-forwarded-host") || headersList.get("host");
  try {
    const store = await lookupStoreByHost(host ?? "");
    return store ? await withStudioPreviewGate(store) : null;
  } catch (err) {
    // Expected unknown/ineligible host. The throw is internal cache control:
    // rejected lookups are not persisted, so a slug created a
    // moment later is visible on the next request, on every app instance.
    if (
      err instanceof StoreHostMiss ||
      (err instanceof Error && err.message === "STORE_HOST_MISS")
    )
      return null;

    // Transient DB error → degrade to "no store" for THIS request only. Crucially
    // this null is NOT cached (the throw inside lookupStoreByHost bypasses
    // request memoization), so once the DB is back the very next request resolves the
    // real store instead of serving a poisoned null for the revalidate window.
    // warn, not error: this is a transient, self-healing condition (the next
    // request retries), so it shouldn't trip the dev error overlay or pollute
    // prod Error Reporting.
    console.warn(
      "lookupStoreByHost (transient, degraded to no-store):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// Resolve the store for the *current* request. Never returns null: unresolved
// hosts fall back to WholeSip so non-storefront callers (dashboard/actions that
// thread a store id into queries) never crash. NOTE: the storefront itself must
// NOT rely on this fallback — it uses getCurrentStoreOrNull() and 404s on an
// unknown host. WholeSip resolves on its own hosts (wholesip.com, its subdomain)
// via lookupStoreByHost, so this fallback only ever covers genuine misses.
export async function getCurrentStore(): Promise<Store> {
  const resolved = await getCurrentStoreOrNull();
  if (resolved) return resolved;

  try {
    const fallback = await lookupStoreById(FALLBACK_STORE_ID);
    if (fallback) return fallback;
  } catch (err) {
    // DB error resolving the fallback → fall through to the synthetic store
    // (never cached as null; retries next request).
    console.warn(
      "lookupStoreById (transient, degraded to synthetic fallback):",
      err instanceof Error ? err.message : err,
    );
  }

  // Last-resort synthetic store so callers never crash even if the row is
  // somehow missing (e.g. mid-migration). store_id still resolves correctly.
  return {
    id: FALLBACK_STORE_ID,
    slug: "wholesip",
    name: "WholeSip",
    status: "active",
    plan: "pro",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
    custom_domain: null,
    settings: {},
  };
}

// Convenience: just the current store's id (the value threaded into queries).
export async function getCurrentStoreId(): Promise<string> {
  return (await getCurrentStore()).id;
}

// RENDER-CONTEXT ONLY (storefront pages). Resolve the current store or trigger
// a 404 when the host maps to no real store. A layout `notFound()` does NOT
// abort concurrently-rendering child pages in the App Router, so each storefront
// PAGE must guard itself — otherwise an unclaimed subdomain would still render
// (and serve in its HTML source) the WholeSip fallback content. Never call this
// from a server action / non-render context (notFound() would throw there).
export async function requireStorefrontStore(): Promise<Store> {
  const store = await getCurrentStoreOrNull();
  if (!store) notFound();
  return store;
}

export async function requireStorefrontStoreId(): Promise<string> {
  return (await requireStorefrontStore()).id;
}
