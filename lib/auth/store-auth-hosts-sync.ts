import "server-only";

// ---------------------------------------------------------------------------
// The sweep that keeps every active store's exact hosts authorized for phone
// sign-in (why exact: lib/auth/store-auth-hosts.ts).
//
// ★ ADD-ONLY. It never removes an entry: removal belongs to the moment a store
// is deleted or a domain detached, where the caller knows the host is truly
// gone. A sweep that removed "anything not expected" would delete a host on a
// transient read gap and break a live store's phone sign-in until the next run.
//
// ★ ONE WRITE. Every host goes to a single ensureAuthorizedHosts call, so the
// project-global list is read and PATCHed once per sweep rather than once per
// store, which also keeps the read-modify-write race to one window.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { ensureAuthorizedHosts } from "./authorized-domains";
import { storeAuthHosts } from "./store-auth-hosts";

export interface StoreAuthHostSyncResult {
  /** Active stores read. */
  stores: number;
  /** Distinct hosts those stores need listed. */
  expected: number;
  /** Hosts this run appended to the list. */
  added: string[];
  error?: string;
}

/** Add every active store's missing exact hosts in one write. Never throws. */
export async function syncStoreAuthHosts(): Promise<StoreAuthHostSyncResult> {
  // Outside the try so a failed write still reports what was read.
  let storeCount = 0;
  let expected: string[] = [];
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: stores.id,
          slug: stores.slug,
          customDomain: stores.customDomain,
          settings: stores.settings,
        })
        .from(stores)
        .where(eq(stores.status, "active")),
    );
    storeCount = rows.length;

    // A Set keeps first-seen order and stays linear across thousands of stores.
    const seen = new Set<string>();
    for (const row of rows) {
      const hosts = storeAuthHosts(
        {
          slug: row.slug,
          custom_domain: row.customDomain,
          settings: row.settings,
        },
        ROOT_DOMAIN,
      );
      for (const host of hosts) seen.add(host);
    }
    expected = [...seen];

    const result = await ensureAuthorizedHosts(expected);
    if (result.error) {
      logError("syncStoreAuthHosts", result.error, {
        stores: storeCount,
        expected: expected.length,
      });
    }
    return {
      stores: storeCount,
      expected: expected.length,
      added: result.added,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    logError("syncStoreAuthHosts", err);
    return {
      stores: storeCount,
      expected: expected.length,
      added: [],
      error: err instanceof Error ? err.message : "store auth host sync failed",
    };
  }
}
