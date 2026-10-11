import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { admins, platformAdmins, storeAccess } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreOrNull, type Store } from "@/lib/store/resolve";
import { isStorefrontGated, isThemePending } from "@/lib/store/launch-state";
import { STORE_CLOSED_MESSAGE } from "@/lib/store/launch-copy";
import { logError } from "@/lib/observability/logger";
import {
  STOREFRONT_GRANT_COOKIE,
  generateStorefrontPassword,
  storefrontGrantsConfigured,
  verifyStorefrontGrant,
} from "@/lib/store/storefront-grant";

// ---------------------------------------------------------------------------
// Who may see a storefront that has not opened yet.
//
// A new store is created closed (lib/store/launch-state.ts). Until its owner
// finishes the go-live checklist and presses Go live, three kinds of request
// may still reach the storefront:
//
//   open      the store is launched (or a demo) — nobody is asked anything.
//   unlocked  the visitor entered the store password, OR is signed in as one
//             of this store's admins or a platform operator. They see the real
//             shop, exactly as it will look on the day it opens.
//   locked    everyone else. Pages redirect to /password and every public
//             write (orders, enquiries, reviews, newsletter, accounts) is
//             refused with STORE_CLOSED_MESSAGE.
//
// ★ THE GATE LIVES IN THE RESOLVER, not the proxy and not the layout. The
// proxy does no database work and cannot know whether a store is gated; a
// layout redirect does not abort a concurrently rendering child page (the
// reason every storefront page calls requireStorefrontStore() itself,
// CODEBASE.md §3). requireStorefrontStore() is the one function every page
// already calls, so it is where the question is asked.
//
// ★ THE HOST DECIDES, never an argument (the demo-guard rule): the store comes
// from the request, so a caller cannot name a different store to get past it.
//
// ★★ THE OWNER IS GATED TOO (owner's decision, 2026-10-08). A first version
// let any signed-in admin of the store through on their session. That made
// the password invisible to the one person who needs to understand it — the
// owner never saw what a customer sees — and it made "Preview store" a
// different experience from sharing the link. Shopify's rule, adopted: the
// password page is what EVERYONE gets, the owner included; the owner has the
// password on their dashboard Home and types it like anyone else. The ONE
// exception is the Website Builder's preview iframe (`?preview=1`, carried as
// the `x-sm-preview` header by proxy.ts) for a request that also carries an
// admin session: without it the builder is blind until the store opens, and
// that preview is already gated by getManagerUserId("builder") in the draft
// loaders it feeds.
// ---------------------------------------------------------------------------

export type StorefrontAccess = "open" | "unlocked" | "locked";

export interface StorefrontPassword {
  password: string;
  version: number;
}

async function readPasswordRow(
  storeId: string,
): Promise<StorefrontPassword | null> {
  const rows = await withService((db) =>
    db
      .select({
        password: storeAccess.password,
        version: storeAccess.passwordVersion,
      })
      .from(storeAccess)
      .where(eq(storeAccess.storeId, storeId))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * The store's current password, created on first read.
 *
 * ★ INSERT … ON CONFLICT DO NOTHING, THEN READ THE WINNER: two dashboard tabs
 * opening Home at the same moment must not generate two passwords and show a
 * merchant one the gate will refuse. Whoever loses the insert reads the row
 * the winner wrote.
 */
export async function getOrCreateStorefrontPassword(
  storeId: string,
): Promise<StorefrontPassword> {
  const existing = await readPasswordRow(storeId);
  if (existing) return existing;
  await withService((db) =>
    db
      .insert(storeAccess)
      .values({ storeId, password: generateStorefrontPassword() })
      .onConflictDoNothing({ target: storeAccess.storeId }),
  );
  const row = await readPasswordRow(storeId);
  if (!row) throw new Error("storefront password could not be created");
  return row;
}

/** Replace the password and invalidate every grant issued against the old
 *  one (the cookie carries the version; a stale version no longer matches). */
export async function rotateStorefrontPassword(
  storeId: string,
): Promise<StorefrontPassword> {
  await getOrCreateStorefrontPassword(storeId);
  await withService((db) =>
    db
      .update(storeAccess)
      .set({
        password: generateStorefrontPassword(),
        passwordVersion: sql`${storeAccess.passwordVersion} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeAccess.storeId, storeId)),
  );
  const row = await readPasswordRow(storeId);
  if (!row) throw new Error("storefront password could not be rotated");
  return row;
}

/** Is the signed-in user (if any) one of this store's admins, or a platform
 *  operator? Fails CLOSED: an unreadable row is not an admin. */
const viewerIsStoreStaff = cache(async (storeId: string): Promise<boolean> => {
  let user;
  try {
    user = await getServerUser();
  } catch {
    return false;
  }
  if (!user) return false;
  try {
    const [adminRows, platformRows] = await Promise.all([
      withService((db) =>
        db
          .select({ id: admins.id })
          .from(admins)
          .where(and(eq(admins.id, user.id), eq(admins.storeId, storeId)))
          .limit(1),
      ),
      user.email
        ? withService((db) =>
            db
              .select({ id: platformAdmins.id })
              .from(platformAdmins)
              .where(eq(platformAdmins.email, user.email as string))
              .limit(1),
          )
        : Promise.resolve([]),
    ]);
    return adminRows.length > 0 || platformRows.length > 0;
  } catch (err) {
    logError("storefront access: staff lookup failed", err, { storeId });
    return false;
  }
});

/**
 * Request-memoized: the resolver runs several times per render (layout,
 * metadata, the page itself), and each would otherwise re-read the cookie and
 * the password row. The layout asks it for every store, but an ungated
 * (launched or demo) store gets "open" before any cookie or database read, so
 * a launched store never pays for any of this.
 */
export const storefrontAccess = cache(
  async (store: Pick<Store, "id" | "settings">): Promise<StorefrontAccess> => {
    if (!isStorefrontGated(store)) return "open";

    // The builder's preview iframe only — see the header comment.
    if ((await headers()).get("x-sm-preview") === "1") {
      if (await viewerIsStoreStaff(store.id)) return "unlocked";
    }

    if (!storefrontGrantsConfigured()) {
      // No signing key means no grant can ever have been minted, so the only
      // way in is a session. Logged, because the merchant's "Preview store"
      // link will land on a password page that cannot accept the password.
      logError(
        "storefront access: no signing key (set CRON_SECRET or STOREFRONT_PASSWORD_SECRET)",
        null,
        { storeId: store.id },
      );
      return "locked";
    }

    const jar = await cookies();
    const claims = verifyStorefrontGrant(
      jar.get(STOREFRONT_GRANT_COOKIE)?.value,
    );
    if (!claims || claims.sid !== store.id) return "locked";
    try {
      const current = await readPasswordRow(store.id);
      return current && current.version === claims.v ? "unlocked" : "locked";
    } catch (err) {
      logError("storefront access: password row unreadable", err, {
        storeId: store.id,
      });
      return "locked"; // fail closed: cannot prove the grant is still current
    }
  },
);

export type StorefrontShell = "bare" | "full";

/**
 * Which shell the storefront layout wraps the page in.
 *
 * "bare" is the brand and theme colours around the page and nothing else: no
 * header, footer, cart or sign-in. It is for the two cases where the only page
 * a visitor can reach is a gate's own page, so the shop's menus, cart and
 * sign-in would all lead straight back to it:
 *
 *   - a LOCKED visitor, who only ever sees /password;
 *   - a store whose owner has not chosen a theme (isThemePending), where
 *     everyone past the password only ever sees /in-progress — whatever
 *     `access` is, the owner included.
 *
 * Everything else, including legacy and fallback stores with no
 * `themePending` key, gets the full shop. Pure, so the layout's choice is
 * tested here rather than by reading the layout's source.
 */
export function storefrontShell(
  store: { settings?: Record<string, unknown> | null },
  access: StorefrontAccess,
): StorefrontShell {
  return access === "locked" || isThemePending(store) ? "bare" : "full";
}

/**
 * The refusal for a public storefront WRITE on a store that has not opened,
 * else null. Sits beside demoStoreRefusal() in every public action: a locked
 * visitor could otherwise reach placeOrder, submitEnquiry or the newsletter
 * through a deep link or a direct action call and leave an order, an enquiry
 * or a consent row on a shop nobody is watching yet.
 *
 * A visitor who entered the password ("unlocked") is NOT refused — that is the
 * merchant testing their own checkout, which is exactly what the password is
 * for.
 */
export async function storefrontClosedRefusal(): Promise<string | null> {
  const store = await getCurrentStoreOrNull();
  if (!store || !isStorefrontGated(store)) return null;
  return (await storefrontAccess(store)) === "locked"
    ? STORE_CLOSED_MESSAGE
    : null;
}
