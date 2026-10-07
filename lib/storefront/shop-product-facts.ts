// What the shop's sort and filters know about one product — the bridge from a
// stored product row to `ShopFacts`. Pure and client-safe.
//
// ★ THE CARD'S OWN RULES, NOT A SECOND COPY: price is `effectivePricing` (what
// the card shows) for the sort, and each variant's price is
// `variantEffectiveSelling` (what checkout charges); availability is the same
// `isSoldOut` the card's "Sold out" flag reads. A filter that disagreed with
// the card under it would be worse than no filter.

import { effectivePricing, variantEffectiveSelling } from "@/lib/pricing";
import { isSoldOut, productIsSoldOut } from "@/lib/inventory/status";
import { normalizeOptions } from "@/lib/products/options";
import {
  facetKey,
  valueKey,
  type FacetOption,
  type FacetVariant,
  type ShopFacts,
} from "./shop-filters";

export interface FacetableProduct {
  name: string;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  created_at?: string | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  /** Stored option axes (jsonb); anything malformed is treated as none. */
  options?: unknown;
  variants: {
    base_price: number;
    selling_price: number;
    special_price?: number | null;
    sort_order?: number;
    track_inventory: boolean;
    stock: number;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
    option_values?: string[] | null;
  }[];
}

export function shopFactsFor(
  p: FacetableProduct,
  categorySlugById: ReadonlyMap<string, string>,
): ShopFacts {
  const parsed = normalizeOptions(p.options);
  const axes = "options" in parsed ? parsed.options : [];

  const options: FacetOption[] = axes.map((axis) => ({
    key: facetKey(axis.name),
    label: axis.name,
    values: axis.values.map((label) => ({
      key: valueKey(label),
      label,
      ...(axis.swatches?.[label] ? { swatch: axis.swatches[label] } : {}),
    })),
  }));

  // A variant carries option values only when it has one per axis; a legacy
  // name-only variant matches no option filter rather than a wrong one.
  const variants: FacetVariant[] = p.variants.map((v) => {
    const values: Record<string, string> = {};
    const raw = v.option_values ?? [];
    if (axes.length > 0 && raw.length === axes.length) {
      axes.forEach((axis, i) => {
        const value = raw[i]?.trim();
        if (value) values[facetKey(axis.name)] = valueKey(value);
      });
    }
    return {
      values,
      price: variantEffectiveSelling(v),
      available: !isSoldOut(v),
    };
  });

  return {
    price: effectivePricing(p).selling,
    soldOut: productIsSoldOut(p.variants, p),
    name: p.name,
    createdAt: p.created_at ?? null,
    categoryKey: p.category_id
      ? (categorySlugById.get(p.category_id) ?? null)
      : null,
    variants,
    options,
  };
}
