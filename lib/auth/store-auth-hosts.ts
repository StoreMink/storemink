// ---------------------------------------------------------------------------
// The exact hostnames a store needs in Identity Platform's authorizedDomains.
//
// ★ WHY EXACT HOSTS. Phone sign-in's server-side reCAPTCHA check matches the
// page's EXACT hostname: on 2026-10-10 echoss.storemink.com failed with
// "CAPTCHA_CHECK_FAILED : Hostname match not found" although storemink.com was
// listed, and adding echoss.storemink.com fixed it at once. The subdomain
// coverage in lib/auth/authorized-domains.ts `entryCovers` is true only for
// signInWithPopup. So every surface that sends a phone code (storefront
// sign-in, enquiries, POS, the dashboard's mobile check) needs its own host
// listed, and this module says which hosts those are.
//
// PURE and import-light (no db, no server-only), so the store-creation and
// domain flows can ask the same question the sweep asks
// (lib/auth/store-auth-hosts-sync.ts).
// ---------------------------------------------------------------------------

import { domainHosts, normalizeDomain } from "@/lib/domains/domain";
import { isDemoStore } from "@/lib/store/launch-state";
import { isLocalDevHostname } from "@/lib/store/host";
import { studioPreviewMarker } from "@/lib/theme-studio/preview-store";

const MAX_HOSTNAME = 253;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Reduce a host (or a pasted URL) to the bare, lowercase form the list stores.
 * Strips scheme, credentials, port, path and trailing dots. Null for empty or
 * invalid input, including wildcards, underscores and bracketed IPv6, none of
 * which Identity Platform accepts as an authorized domain.
 */
export function normalizeAuthHost(host: string): string | null {
  const s = normalizeDomain(host);
  if (!s || s.length > MAX_HOSTNAME) return null;
  return s.split(".").every((label) => LABEL.test(label)) ? s : null;
}

export interface StoreAuthHostInput {
  slug: string;
  custom_domain?: string | null;
  settings?: unknown;
}

function asSettings(settings: unknown): Record<string, unknown> | null {
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : null;
}

/**
 * The exact hosts this store serves sign-in on: `{slug}.{root}`, plus the apex
 * and www forms of a VERIFIED custom domain. Normalised and deduplicated.
 *
 * Empty for a demo store and a Theme Studio preview store (neither ever takes
 * a sign-in), and for a local development root, whose hosts never belong in a
 * real project's list.
 */
export function storeAuthHosts(
  store: StoreAuthHostInput,
  rootDomain: string,
): string[] {
  const settings = asSettings(store.settings);
  if (isDemoStore({ settings }) || studioPreviewMarker(settings)) return [];

  const root = normalizeAuthHost(rootDomain);
  if (!root || isLocalDevHostname(root)) return [];

  const hosts: string[] = [];
  const add = (candidate: string) => {
    const host = normalizeAuthHost(candidate);
    if (host && !hosts.includes(host)) hosts.push(host);
  };

  if (store.slug) add(`${store.slug.trim()}.${root}`);

  // Unverified means we do not serve it yet; the domain flow adds it on the
  // verifying edge (ensureAuthorizedDomain), and this sweep catches it after.
  const custom = store.custom_domain
    ? normalizeAuthHost(store.custom_domain)
    : null;
  if (custom && settings?.custom_domain_verified === true) {
    for (const host of domainHosts(custom)) add(host);
  }

  return hosts;
}
