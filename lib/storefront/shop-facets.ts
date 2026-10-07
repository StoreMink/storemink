// ---------------------------------------------------------------------------
// The shop's filter lists — which filters exist for the products in view,
// which values each offers, and how many products each value would show.
// Pure, shared by the sidebar (live) and the drawer (a draft).
//
// ★ VALUES COME FROM THE PRODUCTS IN SCOPE, not from the store's whole
// catalogue: a collection of shoes shows shoe sizes, not T-shirt sizes. The
// scope is the collection / search, BEFORE the shopper's own filters — so a
// value stays listed (greyed, with a 0) when other filters exclude it, rather
// than vanishing from under the cursor.
//
// ★ EACH COUNT IGNORES ITS OWN FILTER (Shopify's behaviour, "disjunctive"
// counts). With Size M ticked, the Size list still says how many L there are
// — the number a shopper gets by ADDING L, since values within a filter OR.
// Every other active filter still applies.
//
// ★ A FILTER WITH ONE VALUE IS NOT SHOWN (unless that value is ticked): it
// cannot narrow anything, and a list of one reads like a broken control.
// ---------------------------------------------------------------------------

import {
  matchesShopQuery,
  priceSpan,
  type ShopFacts,
  type ShopQuery,
} from "./shop-filters";

/** More than this and the list is not a filter any more (Shopify caps at 100). */
const MAX_FACET_VALUES = 100;

export interface FacetValue {
  key: string;
  label: string;
  /** Products this value would show alongside the other active filters. */
  count: number;
  selected: boolean;
  /** Hex colour for a colour filter. */
  swatch?: string;
}

export type FacetKind = "category" | "size" | "color" | "list";

export interface Facet {
  /** `category` or the option key (`size`, `color`). */
  key: string;
  kind: FacetKind;
  label: string;
  values: FacetValue[];
  /** Selected values, for the "Size (2)" summary. */
  selectedCount: number;
}

export interface ShopFacetView {
  facets: Facet[];
  /** In-stock products alongside the other filters. */
  inStockCount: number;
  /** Price span of products passing every filter but price. */
  span: { min: number; max: number } | null;
  /** Products passing every filter. */
  total: number;
}

export interface CategoryOptionInput {
  slug: string;
  name: string;
}

// Clothing sizes in wearing order; anything else falls back to numbers, then
// first-seen order. "2XL" and "XXL" are the same rung.
const SIZE_RANK: Record<string, number> = {
  xxxs: 0,
  "3xs": 0,
  xxs: 1,
  "2xs": 1,
  xs: 2,
  s: 3,
  small: 3,
  m: 4,
  medium: 4,
  l: 5,
  large: 5,
  xl: 6,
  xxl: 7,
  "2xl": 7,
  xxxl: 8,
  "3xl": 8,
  "4xl": 9,
  "5xl": 10,
  "6xl": 11,
};
function sizeRank(key: string): number | null {
  if (key in SIZE_RANK) return SIZE_RANK[key];
  return null;
}

function numberOf(key: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(key);
  return match ? Number(match[1]) : null;
}

function kindOf(key: string, hasSwatch: boolean): FacetKind {
  if (key === "color" || hasSwatch) return "color";
  if (key === "size" || key.endsWith("-size") || key.startsWith("size"))
    return "size";
  return "list";
}

/**
 * Build every filter for the products in scope, counted against `query`.
 * `categories` is the store's category list in display order; pass null where
 * the page is already one category (a collection), so no category filter shows.
 */
export function buildShopFacets<T>(
  items: readonly T[],
  query: ShopQuery,
  facts: (item: T) => ShopFacts,
  categories: readonly CategoryOptionInput[] | null,
): ShopFacetView {
  const all = items.map(facts);

  // ── Collect options and their values in first-seen order ───────────────
  const optionOrder: string[] = [];
  const optionLabel = new Map<string, string>();
  const valueOrder = new Map<string, string[]>();
  const valueLabel = new Map<string, Map<string, string>>();
  const valueSwatch = new Map<string, Map<string, string>>();
  for (const f of all) {
    for (const option of f.options ?? []) {
      if (!optionLabel.has(option.key)) {
        optionOrder.push(option.key);
        optionLabel.set(option.key, option.label);
        valueOrder.set(option.key, []);
        valueLabel.set(option.key, new Map());
        valueSwatch.set(option.key, new Map());
      }
      const order = valueOrder.get(option.key)!;
      const labels = valueLabel.get(option.key)!;
      const swatches = valueSwatch.get(option.key)!;
      for (const v of option.values) {
        if (!labels.has(v.key)) {
          labels.set(v.key, v.label);
          order.push(v.key);
        }
        if (v.swatch && !swatches.has(v.key)) swatches.set(v.key, v.swatch);
      }
    }
  }

  const count = (q: ShopQuery) =>
    all.reduce((n, f) => n + (matchesShopQuery(f, q) ? 1 : 0), 0);

  const facets: Facet[] = [];

  // ── Category (only where the page spans several) ──────────────────────
  if (categories) {
    const present = new Set(
      all.map((f) => (f.categoryKey ?? "").toLowerCase()).filter(Boolean),
    );
    const values: FacetValue[] = categories
      .filter(
        (c) =>
          present.has(c.slug.toLowerCase()) ||
          query.categories.includes(c.slug.toLowerCase()),
      )
      .map((c) => {
        const key = c.slug.toLowerCase();
        return {
          key,
          label: c.name,
          count: count({ ...query, categories: [key] }),
          selected: query.categories.includes(key),
        };
      });
    pushFacet(facets, {
      key: "category",
      kind: "category",
      label: "Category",
      values,
    });
  }

  // ── Option filters (Size, Colour, …) ──────────────────────────────────
  // A ticked filter whose option no longer exists in scope (a link from
  // another collection) is still listed, so it can be unticked.
  for (const key of Object.keys(query.options)) {
    if (!optionLabel.has(key)) {
      optionOrder.push(key);
      optionLabel.set(key, key.replace(/-/g, " "));
      valueOrder.set(key, []);
      valueLabel.set(key, new Map());
      valueSwatch.set(key, new Map());
    }
    for (const v of query.options[key]) {
      const labels = valueLabel.get(key)!;
      if (!labels.has(v)) {
        labels.set(v, v);
        valueOrder.get(key)!.push(v);
      }
    }
  }

  for (const key of optionOrder) {
    const swatches = valueSwatch.get(key)!;
    const kind = kindOf(key, swatches.size > 0);
    const labels = valueLabel.get(key)!;
    const selected = query.options[key] ?? [];
    const keys = sortValues(valueOrder.get(key)!, kind).slice(
      0,
      MAX_FACET_VALUES,
    );
    const values: FacetValue[] = keys.map((v) => ({
      key: v,
      label: labels.get(v) ?? v,
      count: count({ ...query, options: { ...query.options, [key]: [v] } }),
      selected: selected.includes(v),
      ...(swatches.get(v) ? { swatch: swatches.get(v) } : {}),
    }));
    pushFacet(facets, {
      key,
      kind,
      label: optionLabel.get(key)!,
      values,
    });
  }

  const inStockCount = count({ ...query, inStock: true });
  const span = priceSpan(
    all
      .filter((f) => matchesShopQuery(f, query, "price"))
      .flatMap((f) =>
        f.variants?.length ? f.variants.map((v) => v.price) : [f.price],
      ),
  );

  return { facets, inStockCount, span, total: count(query) };
}

function pushFacet(facets: Facet[], facet: Omit<Facet, "selectedCount">): void {
  const selectedCount = facet.values.filter((v) => v.selected).length;
  if (facet.values.length < 2 && selectedCount === 0) return;
  facets.push({ ...facet, selectedCount });
}

function sortValues(keys: readonly string[], kind: FacetKind): string[] {
  if (kind !== "size") return [...keys];
  return keys
    .map((key, index) => ({ key, index }))
    .sort((a, b) => {
      const ra = sizeRank(a.key);
      const rb = sizeRank(b.key);
      if (ra !== null && rb !== null) return ra - rb || a.index - b.index;
      if (ra !== null) return -1;
      if (rb !== null) return 1;
      const na = numberOf(a.key);
      const nb = numberOf(b.key);
      if (na !== null && nb !== null) return na - nb || a.index - b.index;
      if (na !== null) return -1;
      if (nb !== null) return 1;
      return a.index - b.index;
    })
    .map((row) => row.key);
}

/** The label a ticked value shows on its chip, from the facet lists. */
export function facetValueLabel(
  view: ShopFacetView,
  facetKey: string,
  value: string,
): string {
  const facet = view.facets.find((f) => f.key === facetKey);
  return facet?.values.find((v) => v.key === value)?.label ?? value;
}
