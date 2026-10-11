import "server-only";
import { eq, sql } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { STORE_TAG } from "@/lib/store/resolve";

// The predicates are pure and import nothing; they live in launch-state.ts so
// the host resolver can read them without importing this module (which
// imports the resolver). Re-exported here so every existing caller is
// unchanged.
export {
  isDemoStore,
  isStoreLaunched,
  isStoreSearchIndexable,
  isStorefrontGated,
  isThemePending,
} from "@/lib/store/launch-state";

/**
 * Open the store to the public. Idempotent and best-effort.
 *
 * ★★ ONE CALLER: `launchStore` in app/actions/launch-actions.ts, after it has
 * re-run the go-live checklist server-side. It used to be called from every
 * publish path (pages, products, blogs, CSV imports, Mink publication) on the
 * theory that "the merchant published something of their own" was the moment
 * a store deserved to be indexed. That is still true of indexing — but the
 * flag now also drops the storefront password, and a merchant saving their
 * first product has not yet written a refund policy or an address for their
 * invoices. Opening is an explicit act now; publishing stays private until it.
 *
 * Deliberately unable to fail its caller: it runs after the checklist has
 * passed, and a merchant must never see "Go live" fail because a search-engine
 * flag could not be written. The caller re-reads the store afterwards.
 */
export async function markStoreLaunched(storeId: string): Promise<void> {
  try {
    await withService((db) =>
      db
        .update(stores)
        .set({
          settings: sql`COALESCE(${stores.settings}, '{}'::jsonb) || '{"launched":true}'::jsonb`,
        })
        .where(eq(stores.id, storeId)),
    );
    // The host resolver caches `settings`; without this the store stays
    // password-protected and noindex for up to the cache TTL after it opens.
    const { revalidateTag } = await import("next/cache");
    revalidateTag(STORE_TAG, "max");
  } catch (err) {
    logError("markStoreLaunched failed", err, { storeId });
  }
}
