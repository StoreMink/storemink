// ---------------------------------------------------------------------------
// The storefront revamp's digests: the three values a revamp's apply path
// locks against (docs/mink-storefront-revamp.md, section 10).
//
// The snapshot records them, the assembler copies them into the stored plan
// as each target's expected value, and the apply path recomputes them under
// its row locks. Three callers on two sides of an approval, so ONE module:
// a digest computed two ways is a conflict on every apply, or worse, a write
// over a store that moved.
//
// ★★ THE SAME HASH v1 USES, NOT A SECOND COPY OF IT. Every digest here is
//    `digestMinkStorefrontValue` (sha256 over the codebase's canonical JSON,
//    lib/themes/canonical-json.ts), which is what the personalisation and
//    layout paths already store and compare. So a page digest the snapshot
//    took through v1's reader and the one the apply path takes through this
//    module are the same string by construction, and jsonb's key reordering
//    cannot make them differ.
//
// ★ PURE: no I/O, no database, no environment. The hash comes from the
//   server-side storefront contracts (node:crypto), so this module is for
//   server code; a client component has no reason to digest a store.
// ---------------------------------------------------------------------------

import type { StoreChrome } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import { digestMinkStorefrontSections } from "../storefront-layout-contract";

/**
 * Digest of a page's whole Builder section list: the optimistic lock a
 * page write is compared with. ★ The ORDERED list, so adding, removing or
 * moving a section changes it (a per-section digest could not see an
 * insertion between two untouched sections).
 */
export function revampSectionsDigest(sections: PageSectionItem[]): string {
  return digestMinkStorefrontSections(sections);
}

/**
 * Digest of a WHOLE chrome draft: header, footer, appearance, design and
 * announcement in one value, because a revamp replaces the whole draft
 * (`store_chrome.draft = plan.chrome.next`), so a change to any part of it
 * is a conflict.
 *
 * ★★ PASS THE SANITISED DRAFT, exactly as the snapshot does: the row's
 *    `sanitizeChromeForSave(draft)`, or `readMenusAsChrome(db, storeId)` for a
 *    store with no `store_chrome` row (v1's rule: such a store's real header
 *    and footer are its old `store_menus` links). Digesting the raw jsonb
 *    instead would report a conflict on every apply, because the raw row may
 *    lack keys the sanitiser fills in.
 */
export function revampChromeDigest(chrome: StoreChrome): string {
  return digestMinkStorefrontValue(chrome);
}

/**
 * Digest of the store's tagline and footer description as stored in
 * `stores.settings.brand`.
 *
 * ★★ BYTE FOR BYTE THE VALUE v1's `brandDigestOf` PRODUCES (it is private to
 *    storefront-personalization-actions.ts, so it is restated here and pinned
 *    equal by digests.test.ts): trimmed text, an empty or non-text value as
 *    null, and the two keys digested together. A blank tagline and an absent
 *    one are therefore the same state, which is what a shopper sees.
 */
export function revampBrandDigest(
  settings: Record<string, unknown> | null,
): string {
  const brand = asRecord(settings?.brand);
  return digestMinkStorefrontValue({
    tagline: textOrNull(brand.tagline),
    blurb: textOrNull(brand.blurb),
  });
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
