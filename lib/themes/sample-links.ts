// ---------------------------------------------------------------------------
// Links to a theme's SAMPLE catalogue, and the copies of a theme's menus and
// pages that leave them out.
//
// Pure, no imports beyond types: lib/themes/switch.ts uses it to install a
// theme into a merchant's store, and the tests read it directly.
//
// ★★ A MERCHANT'S STORE GETS NO SAMPLES (owner, 31 Oct 2026: "the products
//   and categories that come along the theme should not be visible anywhere
//   in the dashboard at all"). A theme's sample products and categories are
//   seeded only into the stores that show a theme off: the demo stores and
//   Theme Studio's preview stores (lib/themes/apply.ts). So when a merchant
//   installs a theme, its menus and the buttons on its pages would point at
//   categories and products that do not exist: a category link would land on
//   an empty shop and a product link on "page not found". These helpers take
//   those links out of the menus (a menu link to nothing is noise) and send a
//   button on a page to the shop instead (a page's button keeps its place in
//   the design).
// ---------------------------------------------------------------------------

import type { FooterGroup, MenuLink, StoreMenus } from "@/lib/menus";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { ThemeDefinition } from "./types";

/** Where a link to the sample catalogue goes once it is taken off a page. */
export const SAMPLE_LINK_FALLBACK = "/shop";

/** The addresses of a theme's sample categories and products, by slug. */
export interface SampleAddresses {
  categories: ReadonlySet<string>;
  products: ReadonlySet<string>;
}

export function sampleAddresses(
  theme: Pick<ThemeDefinition, "preset">,
): SampleAddresses {
  const data = theme.preset.sampleData;
  return {
    categories: new Set((data?.categories ?? []).map((c) => c.slug)),
    products: new Set((data?.products ?? []).map((p) => p.slug)),
  };
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * True when `href` is a site path to one of the theme's sample categories
 * (`/collections/<slug>`, or the older `/shop?category=<slug>`, which
 * redirects there) or sample products (`/shop/<slug>`). An outside address,
 * "/shop" itself and every other page are not.
 */
export function isSampleLink(
  href: string,
  addresses: SampleAddresses,
): boolean {
  const raw = href.trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return false;
  const [pathAndQuery] = raw.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] === "collections") {
    return addresses.categories.has(decoded(parts[1]));
  }
  if (parts.length === 2 && parts[0] === "shop") {
    return addresses.products.has(decoded(parts[1]));
  }
  if (parts.length === 1 && parts[0] === "shop" && query) {
    const category = new URLSearchParams(query).get("category");
    return category !== null && addresses.categories.has(category);
  }
  return false;
}

/** A header tree without sample links. A heading whose own link went keeps
 *  its place while it still has links under it. */
function pruneTree(links: MenuLink[], addresses: SampleAddresses): MenuLink[] {
  const out: MenuLink[] = [];
  for (const link of links) {
    const children = link.children?.length
      ? pruneTree(link.children, addresses)
      : [];
    const sample = isSampleLink(link.href ?? "", addresses);
    if (sample && children.length === 0) continue;
    const next: MenuLink = { label: link.label, href: sample ? "" : link.href };
    if (children.length) {
      next.children = children;
      if (link.image_url) next.image_url = link.image_url;
    }
    if (!next.href && !next.children) continue;
    out.push(next);
  }
  return out;
}

function pruneFlat(links: MenuLink[], addresses: SampleAddresses): MenuLink[] {
  return links.filter((link) => !isSampleLink(link.href ?? "", addresses));
}

/**
 * A theme's menus without links to its sample catalogue. A header left with
 * nothing gets one link to the shop, and a footer left with no column gets
 * one, so the store never falls back to links it does not have.
 */
export function menusWithoutSampleLinks(
  menus: StoreMenus,
  addresses: SampleAddresses,
): StoreMenus {
  let header = pruneTree(menus.header ?? [], addresses);
  if (header.length === 0) {
    header = [{ label: "Shop", href: SAMPLE_LINK_FALLBACK }];
  }
  let footerGroups: FooterGroup[] = (menus.footerGroups ?? [])
    .map((group) => ({
      title: group.title,
      links: pruneFlat(group.links ?? [], addresses),
    }))
    .filter((group) => group.links.length > 0);
  if (footerGroups.length === 0) {
    footerGroups = [
      {
        title: "Shop",
        links: [{ label: "All products", href: SAMPLE_LINK_FALLBACK }],
      },
    ];
  }
  return {
    header,
    footerGroups,
    footerLegal: pruneFlat(menus.footerLegal ?? [], addresses),
  };
}

/** A link field of a section's config: `href` or any key ending `_href`. */
function isLinkKey(key: string): boolean {
  return key === "href" || key.endsWith("_href");
}

function rewrite(value: unknown, addresses: SampleAddresses): unknown {
  if (Array.isArray(value))
    return value.map((item) => rewrite(item, addresses));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] =
      isLinkKey(key) &&
      typeof nested === "string" &&
      isSampleLink(nested, addresses)
        ? SAMPLE_LINK_FALLBACK
        : rewrite(nested, addresses);
  }
  return out;
}

/**
 * A page's sections with every button and tile that pointed at a sample
 * category or product sent to the shop instead. Nothing else changes, and a
 * section with no such link is returned as it was.
 */
export function sectionsWithoutSampleLinks(
  sections: PageSectionItem[],
  addresses: SampleAddresses,
): PageSectionItem[] {
  if (addresses.categories.size === 0 && addresses.products.size === 0) {
    return sections;
  }
  return sections.map((section) => ({
    ...section,
    config: rewrite(section.config, addresses) as PageSectionItem["config"],
  }));
}
