// ---------------------------------------------------------------------------
// The sample clean-up's rules: which seeds a store's samples can come from,
// and the copies of its menus, header, footer and pages without links to the
// samples the clean-up removed.
//
// Pure and import-light (types, the menu cleaner and sample-links), so the
// tests read it directly. lib/themes/sample-cleanup.ts reads the rows, asks
// these rules and writes the result; scripts/remove-theme-samples.ts runs it
// for every store.
//
// ★★ WHY THIS EXISTS (owner, 31 Oct 2026). A theme's sample products and
// categories "should not be visible anywhere in the dashboard at all". Since
// that morning no merchant store gets them, but every store that installed a
// theme earlier (Basket at signup before 2026-10-11, or any theme from the
// dashboard before 31 Oct) still holds them. This removes them, and only
// them.
//
// ★ A SAMPLE IS ONE THE MERCHANT NEVER MADE THEIR OWN. A product is a sample
// when its address AND name are a seed's, it is still a draft, and its content
// is the seed's: either untouched since it was created (content_updated_at
// within a minute of created_at, the old switch rule) or still carrying the
// seed's description, main photo and prices (a store-wide redesign that took
// samples off the shop moves content_updated_at, and that is not the merchant
// making the product theirs). A category is a sample when its address and name
// are a seed's and its description and photo are the seed's, or it was never
// changed after it was created. Anything renamed, published, repriced or
// rewritten is the merchant's and stays.
// ---------------------------------------------------------------------------

import { NAV_LIMITS, type NavLink } from "@/lib/chrome/nav";
import { sanitizeMenusForSave, type StoreMenus } from "@/lib/menus";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  isSampleLink,
  menusWithoutSampleLinks,
  SAMPLE_LINK_FALLBACK,
  sectionsWithoutSampleLinks,
  type SampleAddresses,
} from "./sample-links";
import type { ThemeDefinition } from "./types";

/** What a seeded product looked like when the theme wrote it. */
export interface ProductSeed {
  slug: string;
  name: string;
  description: string;
  imageUrl: string;
  basePrice: number;
  sellingPrice: number;
}

/** What a seeded category looked like when the theme wrote it. */
export interface CategorySeed {
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
}

export interface SampleSeeds {
  products: ProductSeed[];
  categories: CategorySeed[];
}

/**
 * Every sample seed of `themes`, each once. A store's samples may come from a
 * theme it no longer uses (a dashboard switch before 31 Oct kept the previous
 * theme's samples while the store had products of its own), so the clean-up
 * checks every bundled theme as well as the installed one.
 */
export function sampleSeedsFor(
  themes: Iterable<Pick<ThemeDefinition, "preset">>,
): SampleSeeds {
  const products = new Map<string, ProductSeed>();
  const categories = new Map<string, CategorySeed>();
  for (const theme of themes) {
    const data = theme.preset.sampleData;
    for (const p of data?.products ?? []) {
      const seed: ProductSeed = {
        slug: p.slug,
        name: p.name,
        description: p.description,
        imageUrl: p.image_url,
        basePrice: p.base_price,
        sellingPrice: p.selling_price,
      };
      products.set(JSON.stringify(seed), seed);
    }
    for (const c of data?.categories ?? []) {
      const seed: CategorySeed = {
        slug: c.slug,
        name: c.name,
        description: c.description ?? null,
        imageUrl: c.image_url ?? null,
      };
      categories.set(JSON.stringify(seed), seed);
    }
  }
  return {
    products: [...products.values()],
    categories: [...categories.values()],
  };
}

/** The addresses of the samples a store just lost. */
export function removedSampleAddresses(removed: {
  productSlugs: readonly string[];
  categorySlugs: readonly string[];
}): SampleAddresses {
  return {
    products: new Set(removed.productSlugs),
    categories: new Set(removed.categorySlugs),
  };
}

function hasAnyAddress(addresses: SampleAddresses): boolean {
  return addresses.products.size > 0 || addresses.categories.size > 0;
}

/** True when any link in the tree goes to one of `addresses`. */
export function linksReachSample(
  links: readonly NavLink[],
  addresses: SampleAddresses,
): boolean {
  return links.some(
    (link) =>
      isSampleLink(link.href ?? "", addresses) ||
      (link.children ? linksReachSample(link.children, addresses) : false),
  );
}

/** True when a link in the tree leads into the catalogue: the shop, a
 *  product or a collection. */
function linksReachCatalogue(links: readonly NavLink[]): boolean {
  return links.some((link) => {
    const path = (link.href ?? "").trim().split(/[?#]/)[0] ?? "";
    return (
      path === "/shop" ||
      path.startsWith("/shop/") ||
      path.startsWith("/collections/") ||
      (link.children ? linksReachCatalogue(link.children) : false)
    );
  });
}

/**
 * A header that lost its links to the removed samples, with a link to the
 * shop first when nothing left in it leads into the catalogue. A theme's
 * header usually reached the shop only through its sample categories
 * ("Women", "Men", "Handbags"), and taking those out would otherwise leave a
 * header with no way to the products at all.
 */
function headerWithShopLink(header: NavLink[]): NavLink[] {
  if (linksReachCatalogue(header)) return header;
  return [{ label: "Shop", href: SAMPLE_LINK_FALLBACK }, ...header].slice(
    0,
    NAV_LIMITS.topLevel,
  );
}

/**
 * A store's menus without links to the removed samples, or null when none
 * linked to them. Only a part that held such a link changes, so a footer the
 * merchant left empty on purpose stays empty; a part left with nothing gets
 * the same one link to the shop a theme install would give it, and a header
 * left with no way into the catalogue gets a link to the shop first.
 */
export function menusWithoutRemovedSamples(
  raw: unknown,
  addresses: SampleAddresses,
): StoreMenus | null {
  if (!hasAnyAddress(addresses)) return null;
  const menus = sanitizeMenusForSave(raw);
  const header = linksReachSample(menus.header, addresses);
  const footer = menus.footerGroups.some((group) =>
    linksReachSample(group.links, addresses),
  );
  const legal = linksReachSample(menus.footerLegal, addresses);
  if (!header && !footer && !legal) return null;
  const pruned = menusWithoutSampleLinks(menus, addresses);
  return {
    header: header ? headerWithShopLink(pruned.header) : menus.header,
    footerGroups: footer ? pruned.footerGroups : menus.footerGroups,
    footerLegal: legal ? pruned.footerLegal : menus.footerLegal,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A store's Website Builder header and footer (a store_chrome draft or
 * published value) without links to the removed samples, or null when none
 * linked to them. Everything else in the value is kept exactly as stored:
 * only the header links, the announcement bar's link, the footer columns and
 * the legal row can change.
 */
export function chromeWithoutRemovedSamples(
  raw: unknown,
  addresses: SampleAddresses,
): Record<string, unknown> | null {
  const chrome = record(raw);
  if (!chrome || !hasAnyAddress(addresses)) return null;
  const header = record(chrome.header) ?? {};
  const footer = record(chrome.footer) ?? {};
  const menus = menusWithoutRemovedSamples(
    {
      header: header.links,
      footerGroups: footer.groups,
      footerLegal: footer.legal,
    },
    addresses,
  );
  const announcement = record(header.announcement);
  const announcementHref =
    announcement && typeof announcement.href === "string"
      ? announcement.href
      : "";
  const announcementLinked =
    !!announcementHref && isSampleLink(announcementHref, addresses);
  if (!menus && !announcementLinked) return null;

  const next: Record<string, unknown> = { ...chrome };
  const nextHeader: Record<string, unknown> = { ...header };
  if (menus) {
    nextHeader.links = menus.header;
    next.footer = {
      ...footer,
      groups: menus.footerGroups,
      legal: menus.footerLegal,
    };
  }
  if (announcementLinked && announcement) {
    nextHeader.announcement = { ...announcement, href: SAMPLE_LINK_FALLBACK };
  }
  next.header = nextHeader;
  return next;
}

/**
 * A page's stored sections with every button and tile that pointed at a
 * removed sample sent to the shop instead, or null when nothing changed.
 */
export function sectionsWithoutRemovedSamples(
  raw: unknown,
  addresses: SampleAddresses,
): PageSectionItem[] | null {
  if (!Array.isArray(raw) || !hasAnyAddress(addresses)) return null;
  const sections = raw as PageSectionItem[];
  const next = sectionsWithoutSampleLinks(sections, addresses);
  return JSON.stringify(next) === JSON.stringify(sections) ? null : next;
}
