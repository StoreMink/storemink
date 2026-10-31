import "server-only";

/**
 * StoreMink's GST settings for the public pages (GST design 5.11).
 *
 * The pricing pages, the POS page and anything else a visitor reads show
 * prices with GST in mind, so they need to know whether GST is charged and
 * whether a change is scheduled. They read it here, cached, beside
 * `getPlanPricing()`.
 *
 * ★ ONLY THE TAX TERMS: `getPublicTaxSource` returns the seven columns that
 * decide which GST applies (`TaxTermsSource`), nothing else: no GSTIN, no
 * address, nothing private. A page calls `termsAt(source, new Date())` when it
 * renders, so a scheduled start shows within one revalidation (300 seconds)
 * without a deploy, even before the hourly run promotes it.
 *
 * ★★ ANYTHING FOLLOWED BY A PAYMENT READS LIVE: the dashboard, signup and every
 * quote use `getTaxTermsLive()` (re-exported here), never this cache.
 *
 * The three console saves bust the tag after they commit, and the hourly run
 * busts it when it promoted a change (`bustPlatformTax`).
 */

import { unstable_cache } from "next/cache";
import {
  PLATFORM_TAX_TAG,
  bustPlatformTax,
  getTaxTermsLive,
  readTaxTermsSource,
} from "./platform-settings";
import type { TaxTermsSource } from "./tax-terms";

export { PLATFORM_TAX_TAG, bustPlatformTax, getTaxTermsLive };

/** The cache key of the public source. */
export const PUBLIC_TAX_CACHE_KEY = "platform-tax-terms";

/** How long a cached copy may be served without a bust, in seconds. */
export const PUBLIC_TAX_REVALIDATE_SECONDS = 300;

const cachedPublicTaxSource = unstable_cache(
  () => readTaxTermsSource(),
  [PUBLIC_TAX_CACHE_KEY],
  { tags: [PLATFORM_TAX_TAG], revalidate: PUBLIC_TAX_REVALIDATE_SECONDS },
);

/** `unstable_cache` refuses to run without a render or request scope. */
function isMissingCacheScope(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /incrementalCache missing/i.test(message);
}

/**
 * The GST settings for a public page, cached for up to 300 seconds under the
 * tag `platform-tax`.
 *
 * ★ A READ FAILURE THROWS AND IS NEVER CACHED: `unstable_cache` stores only a
 * value the read returned, so the next request reads again. A page that must
 * render anyway catches it and shows its prices without a GST sentence; it
 * never guesses that GST is off.
 *
 * ★ Outside a render or a request (a script, a test without Next), the cache
 * cannot run, so the source is read live instead of failing.
 */
export async function getPublicTaxSource(): Promise<TaxTermsSource> {
  try {
    return await cachedPublicTaxSource();
  } catch (err) {
    if (isMissingCacheScope(err)) return readTaxTermsSource();
    throw err;
  }
}
