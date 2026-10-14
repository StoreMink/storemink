import "server-only";

import { and, inArray, ne } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { domainHosts } from "./domain";

/**
 * The hostnames in `hosts` that a store still has connected — through its own
 * custom domain OR that domain's apex/www companion.
 *
 * ★★ WHY THIS EXISTS. A store connected to `acme.com` is served on
 * `acme.com` AND `www.acme.com` (`domainHosts`), with one certificate, DNS
 * authorization and map entry per hostname, named deterministically by the
 * hostname alone. `stores.custom_domain` is unique only as an exact string, so a
 * second store could connect `www.acme.com`, adopt the first store's resources
 * and then, on disconnect, delete the certificates for BOTH forms — taking the
 * first store's live HTTPS down. Saving now refuses that claim, and teardown
 * keeps every hostname this returns.
 *
 * ★ Matching `custom_domain IN hosts` is complete, not an approximation: the
 * companion relation is symmetric and `hosts` is already a full `domainHosts`
 * set, so another store's domain shares a hostname with it exactly when that
 * domain is itself in the set.
 *
 * Throws on a failed read. Callers must treat that as "still in use": a leftover
 * certificate costs cents, deleting a live one is an outage.
 */
export async function hostsConnectedToStores(
  hosts: readonly string[],
  opts: { exceptStoreId?: string } = {},
): Promise<Set<string>> {
  if (hosts.length === 0) return new Set();
  const rows = await withService((db) =>
    db
      .select({ customDomain: stores.customDomain })
      .from(stores)
      .where(
        and(
          inArray(stores.customDomain, [...hosts]),
          opts.exceptStoreId ? ne(stores.id, opts.exceptStoreId) : undefined,
        ),
      ),
  );

  const wanted = new Set(hosts);
  const connected = new Set<string>();
  for (const row of rows) {
    if (!row.customDomain) continue;
    for (const host of domainHosts(row.customDomain)) {
      if (wanted.has(host)) connected.add(host);
    }
  }
  return connected;
}
