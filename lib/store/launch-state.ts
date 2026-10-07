// ---------------------------------------------------------------------------
// Pure predicates about what a store is FOR, with no imports at all.
//
// They live apart from lib/store/launch.ts because the host RESOLVER
// (lib/store/resolve.ts) needs them to decide whether a storefront request is
// allowed through, and launch.ts imports the resolver for STORE_TAG — a cycle
// this file exists to avoid. launch.ts re-exports them, so every existing
// importer is unchanged.
// ---------------------------------------------------------------------------

type SettingsOnly = { settings?: Record<string, unknown> | null } | null;

/**
 * "Is this shop OPEN to the public?"
 *
 * ★★ THIS IS THE ONE FLAG BEHIND BOTH THE PASSWORD GATE AND INDEXABILITY. A
 * new store is created `launched: false` and stays closed — storefront behind
 * a password, `noindex`, empty sitemap, every public write refused — until
 * its owner completes the go-live checklist and presses Go live
 * (app/actions/launch-actions.ts). Nothing else sets it any more: publishing a
 * product or a page used to flip it, which meant a shop with no refund policy
 * and the theme's placeholder homepage went public and into Google the moment
 * its first product was saved.
 *
 * Legacy stores predate the flag and are already indexed — treating them as
 * unlaunched would put a PASSWORD PAGE in front of live shops, so absence
 * means launched for anything created before the flag existed. Only an
 * explicit `false` closes a store.
 */
export function isStoreLaunched(store: SettingsOnly | undefined): boolean {
  if (!store) return false;
  const v = store.settings?.launched;
  return v !== false;
}

/**
 * Is this a theme's showcase store rather than a real merchant's shop?
 *
 * Demo stores are seeded from a theme package, publicly reachable, and reset on
 * demand — so they must never accept anything a real shop would treat as a
 * commitment. A visitor CAN sign in and place a cash-on-delivery order on one
 * otherwise: it writes a real `orders` row, reserves real stock, and emails a
 * confirmation to somebody who now believes shoes are coming.
 */
export function isDemoStore(store: SettingsOnly | undefined): boolean {
  return store?.settings?.demo === true;
}

/**
 * Is this store eligible to appear in search at all?
 *
 * Keep this as the one gate shared by page metadata, robots, sitemaps and the
 * notification pipeline. A demo may be fully populated and a legacy store may
 * have no `launched` key, so neither `isStoreLaunched()` nor `settings.demo`
 * alone answers the search-indexability question.
 */
export function isStoreSearchIndexable(
  store: SettingsOnly | undefined,
): boolean {
  return isStoreLaunched(store) && !isDemoStore(store);
}

/**
 * Does the public need a password to see this storefront?
 *
 * A demo store is never gated — it is a public showcase by definition and
 * carries its own refusals for anything a visitor might DO there. Everything
 * else is gated exactly while it is unlaunched. The grant that lets a visitor
 * through, and the owner bypass, live in lib/store/storefront-access.ts; this
 * is only the question of whether that machinery is consulted at all.
 */
export function isStorefrontGated(store: SettingsOnly | undefined): boolean {
  if (!store) return false;
  return !isStoreLaunched(store) && !isDemoStore(store);
}
