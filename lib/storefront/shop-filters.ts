// ---------------------------------------------------------------------------
// Shop page sort, filters and "load more" — the pure half, shared by the
// server (which reads the URL and renders the first paint) and the client
// (which applies a change without a round trip).
//
// ★ THE URL IS THE STATE. A sorted, filtered view is a link a shopper can
// share or come back to, so every choice lives in the query string:
// `sort`, `stock=in`, `min`, `max`, `page`, and Shopify-style
// `filter.v.option.<name>=<value>` / `filter.p.category=<slug>` (repeated for
// several values). Defaults are OMITTED, so an untouched page has a clean
// address and `/shop` stays `/shop`. Shopify's own `filter.v.availability=1`
// and `filter.v.price.gte|lte` are read too, so a link copied from a Shopify
// store's habits still works.
//
// ★ AND BETWEEN FILTERS, OR WITHIN ONE — Shopify's rule. "Size M or L" and
// "Black" means M-or-L items that are also black.
//
// ★★ VARIANT-AWARE. "Size M + In stock + under ₹1,000" asks for a VARIANT that
// is M, in stock and under ₹1,000 — not a product that has an M somewhere, any
// in-stock variant and a cheap variant, which can be three different ones.
//
// ★ A BAD PARAMETER IS IGNORED, NEVER AN ERROR. These arrive from links typed
// by hand, pasted into chats and cached by crawlers; a shopper who follows
// `?sort=cheapest` should see the shop, not a 404.
//
// ★ "LOAD MORE" SHOWS PAGES OF WHAT IS ALREADY LOADED. The storefront reads a
// store's whole published catalogue once (cached), so this bounds how many
// cards — and images — the page draws, not how much is fetched. `page=2`
// means "the first two pages", so a shared or reloaded link shows everything
// the shopper had revealed rather than only the last page of it.
// ---------------------------------------------------------------------------

export const SHOP_SORTS = [
  "featured",
  "price-asc",
  "price-desc",
  "newest",
  "name",
] as const;
export type ShopSort = (typeof SHOP_SORTS)[number];

export const SHOP_SORT_LABELS: Record<ShopSort, string> = {
  featured: "Featured",
  "price-asc": "Price, low to high",
  "price-desc": "Price, high to low",
  newest: "Newest",
  name: "Name, A–Z",
};

/** Cards per "page". 24 fills whole rows at 2, 3 and 4 columns. */
export const SHOP_PAGE_SIZE = 24;

/** The page numbers a paged collection shows around the current one: the
 *  first and last always, a window of one either side of the current page,
 *  and `null` where pages are skipped. Seven slots at most, so the control
 *  never wraps on a phone. */
export function pageNumbers(current: number, count: number): (number | null)[] {
  if (count <= 7)
    return Array.from({ length: Math.max(count, 0) }, (_, i) => i + 1);
  const page = Math.min(Math.max(current, 1), count);
  const near = new Set([1, count, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => near.add(n));
  if (page >= count - 2)
    [count - 3, count - 2, count - 1].forEach((n) => near.add(n));
  const out: (number | null)[] = [];
  for (let n = 1; n <= count; n++) {
    if (near.has(n)) out.push(n);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}
/** A crafted `page=` must not ask the grid to draw a whole catalogue twice. */
const MAX_PAGES = 200;
/** Rupees; an absurd bound is dropped rather than honoured. */
const MAX_PRICE = 10_000_000;

/** Caps on what a URL can ask for, so a crafted link stays cheap. */
const MAX_OPTION_FILTERS = 10;
const MAX_VALUES_PER_FILTER = 40;
const MAX_VALUE_LENGTH = 80;

export const OPTION_PARAM_PREFIX = "filter.v.option.";
export const CATEGORY_PARAM = "filter.p.category";

export interface ShopQuery {
  sort: ShopSort;
  /**
   * Variant option filters: facet key (`size`, `color`) → selected value keys
   * (lowercased). See `facetKey` / `valueKey`.
   */
  options: Record<string, string[]>;
  /** Category slugs (only on /shop and search; a collection is one category). */
  categories: string[];
  /** Hide products that cannot be bought right now. */
  inStock: boolean;
  /** Whole rupees, inclusive. Null = no bound. */
  min: number | null;
  max: number | null;
  /** How many pages are revealed (1 = the first SHOP_PAGE_SIZE cards). */
  pages: number;
}

export const DEFAULT_SHOP_QUERY: ShopQuery = {
  sort: "featured",
  options: {},
  categories: [],
  inStock: false,
  min: null,
  max: null,
  pages: 1,
};

type ParamSource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Every [key, value] pair, repeated keys included. */
function entries(source: ParamSource): [string, string][] {
  if (source instanceof URLSearchParams) return [...source.entries()];
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) for (const v of value) out.push([key, v]);
    else if (typeof value === "string") out.push([key, value]);
  }
  return out;
}

/**
 * The filter key for an option name: lowercase, spaces to hyphens, and
 * "Colour" and "Color" are the same filter — two stores' spellings, one idea.
 */
export function facetKey(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  return key === "colour" ? "color" : key;
}

/** Values compare case- and space-insensitively ("Navy Blue" = "navy  blue"). */
export function valueKey(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, MAX_VALUE_LENGTH);
}

function pushUnique(list: string[], value: string, cap: number) {
  if (value && !list.includes(value) && list.length < cap) list.push(value);
}

function readPrice(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) return null;
  return Math.floor(value);
}

export function parseShopQuery(source: ParamSource): ShopQuery {
  const sortRaw = read(source, "sort");
  const sort = (SHOP_SORTS as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as ShopSort)
    : "featured";

  let min = readPrice(
    read(source, "min") ?? read(source, "filter.v.price.gte"),
  );
  let max = readPrice(
    read(source, "max") ?? read(source, "filter.v.price.lte"),
  );
  // A range typed backwards means what it obviously means.
  if (min !== null && max !== null && min > max) [min, max] = [max, min];

  const pageRaw = Number(read(source, "page"));
  const pages =
    Number.isInteger(pageRaw) && pageRaw >= 1
      ? Math.min(pageRaw, MAX_PAGES)
      : 1;

  const options: Record<string, string[]> = {};
  const categories: string[] = [];
  for (const [key, raw] of entries(source)) {
    if (key.startsWith(OPTION_PARAM_PREFIX)) {
      const name = facetKey(key.slice(OPTION_PARAM_PREFIX.length));
      if (!name) continue;
      if (!options[name] && Object.keys(options).length >= MAX_OPTION_FILTERS)
        continue;
      const list = (options[name] ??= []);
      pushUnique(list, valueKey(raw), MAX_VALUES_PER_FILTER);
      if (list.length === 0) delete options[name];
    } else if (key === CATEGORY_PARAM) {
      pushUnique(
        categories,
        raw.trim().toLowerCase().slice(0, 120),
        MAX_VALUES_PER_FILTER,
      );
    }
  }

  return {
    sort,
    options,
    categories,
    inStock:
      read(source, "stock") === "in" ||
      read(source, "filter.v.availability") === "1",
    min,
    max,
    pages,
  };
}

/** A stable string for a view's filters, for change detection. */
export function shopQueryKey(query: ShopQuery): string {
  return shopQueryEntries(query)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** The query-string entries for a view, defaults omitted. */
export function shopQueryEntries(query: ShopQuery): [string, string][] {
  const out: [string, string][] = [];
  if (query.sort !== "featured") out.push(["sort", query.sort]);
  for (const slug of query.categories) out.push([CATEGORY_PARAM, slug]);
  for (const name of Object.keys(query.options).sort()) {
    for (const value of query.options[name])
      out.push([`${OPTION_PARAM_PREFIX}${name}`, value]);
  }
  if (query.inStock) out.push(["stock", "in"]);
  if (query.min !== null) out.push(["min", String(query.min)]);
  if (query.max !== null) out.push(["max", String(query.max)]);
  if (query.pages > 1) out.push(["page", String(query.pages)]);
  return out;
}

/**
 * Write a view onto an existing query string, keeping anything else in it
 * (`q` from the header search) and dropping stale shop keys.
 */
export function withShopQuery(
  base: URLSearchParams,
  query: ShopQuery,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const key of [...next.keys()]) {
    if (
      ["sort", "stock", "min", "max", "page"].includes(key) ||
      key.startsWith("filter.")
    )
      next.delete(key);
  }
  // append, not set: a filter with two values is two entries.
  for (const [key, value] of shopQueryEntries(query)) next.append(key, value);
  return next;
}

/** Filters in force, for the button badge and "Clear all". Sort is not one. */
export function activeFilterCount(query: ShopQuery): number {
  return (
    (query.inStock ? 1 : 0) +
    (query.min !== null || query.max !== null ? 1 : 0) +
    query.categories.length +
    Object.values(query.options).reduce((n, values) => n + values.length, 0)
  );
}

/** The same view with every filter removed (sort kept). */
export function clearedShopQuery(query: ShopQuery): ShopQuery {
  return {
    ...query,
    options: {},
    categories: [],
    inStock: false,
    min: null,
    max: null,
    pages: 1,
  };
}

/** Toggle one value of one option filter. */
export function toggleOptionValue(
  query: ShopQuery,
  key: string,
  value: string,
): ShopQuery {
  const current = query.options[key] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  const options = { ...query.options };
  if (next.length) options[key] = next;
  else delete options[key];
  return { ...query, options, pages: 1 };
}

/** Toggle one category slug. */
export function toggleCategory(query: ShopQuery, slug: string): ShopQuery {
  const categories = query.categories.includes(slug)
    ? query.categories.filter((c) => c !== slug)
    : [...query.categories, slug];
  return { ...query, categories, pages: 1 };
}

/** One buyable variant, as the filters see it. */
export interface FacetVariant {
  /** facet key → value key, e.g. { size: "m", color: "black" }. */
  values: Record<string, string>;
  price: number;
  available: boolean;
}

/** One option axis of a product, for building the filter lists. */
export interface FacetOption {
  key: string;
  label: string;
  values: { key: string; label: string; swatch?: string }[];
}

/** What the sort and filters need to know about one product. */
export interface ShopFacts {
  /** The price a shopper pays, as the card shows it. */
  price: number;
  soldOut: boolean;
  name: string;
  createdAt: string | null;
  /** Category slug, for the category filter. */
  categoryKey?: string | null;
  /**
   * Buyable variants. Absent or empty = a simple product, treated as one
   * variant at `price` / `!soldOut` with no option values.
   */
  variants?: FacetVariant[];
  /** Option axes, for listing filter values. */
  options?: FacetOption[];
}

/** Which filter to leave out when matching (for a facet's own counts). */
export type FacetSkip = "category" | "stock" | "price" | `option:${string}`;

/**
 * Does a product pass the filters? `skip` leaves one filter out — the facet
 * counts use it, so each list counts against the OTHER active filters.
 */
export function matchesShopQuery(
  f: ShopFacts,
  query: ShopQuery,
  skip?: FacetSkip,
): boolean {
  if (
    query.categories.length > 0 &&
    skip !== "category" &&
    !query.categories.includes((f.categoryKey ?? "").toLowerCase())
  )
    return false;

  const optionKeys = Object.keys(query.options).filter(
    (k) => query.options[k].length > 0 && skip !== `option:${k}`,
  );
  const stock = query.inStock && skip !== "stock";
  const priced = skip !== "price" && (query.min !== null || query.max !== null);
  if (optionKeys.length === 0 && !stock && !priced) return true;

  const variants: FacetVariant[] = f.variants?.length
    ? f.variants
    : [{ values: {}, price: f.price, available: !f.soldOut }];
  return variants.some((v) => {
    for (const key of optionKeys) {
      const value = v.values[key];
      if (value === undefined || !query.options[key].includes(value))
        return false;
    }
    if (stock && !v.available) return false;
    if (priced) {
      if (query.min !== null && v.price < query.min) return false;
      if (query.max !== null && v.price > query.max) return false;
    }
    return true;
  });
}

/**
 * Filter then sort. Ties keep the input order, which is the store's own
 * "featured" order, so re-sorting never shuffles products the shopper was
 * already looking at.
 */
export function applyShopQuery<T>(
  items: readonly T[],
  query: ShopQuery,
  facts: (item: T) => ShopFacts,
): T[] {
  const rows = items
    .map((item, index) => ({ item, index, facts: facts(item) }))
    .filter(({ facts: f }) => matchesShopQuery(f, query));

  const byIndex = (a: { index: number }, b: { index: number }) =>
    a.index - b.index;
  const time = (value: string | null) => {
    const t = value ? Date.parse(value) : NaN;
    return Number.isFinite(t) ? t : 0;
  };

  switch (query.sort) {
    case "price-asc":
      rows.sort((a, b) => a.facts.price - b.facts.price || byIndex(a, b));
      break;
    case "price-desc":
      rows.sort((a, b) => b.facts.price - a.facts.price || byIndex(a, b));
      break;
    case "newest":
      rows.sort(
        (a, b) =>
          time(b.facts.createdAt) - time(a.facts.createdAt) || byIndex(a, b),
      );
      break;
    case "name":
      rows.sort(
        (a, b) =>
          a.facts.name.localeCompare(b.facts.name, undefined, {
            sensitivity: "base",
            numeric: true,
          }) || byIndex(a, b),
      );
      break;
    case "featured":
      break;
  }
  return rows.map((row) => row.item);
}

/** The price span of a list, whole rupees, for the filter's placeholders. */
export function priceSpan(
  prices: readonly number[],
): { min: number; max: number } | null {
  const valid = prices.filter((p) => Number.isFinite(p) && p >= 0);
  if (valid.length === 0) return null;
  return {
    min: Math.floor(Math.min(...valid)),
    max: Math.ceil(Math.max(...valid)),
  };
}
