"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SlidersHorizontal, X } from "lucide-react";
import { matchesProductQuery } from "@/lib/storefront/product-search";
import { collectionPath } from "@/lib/storefront/collection-links";
import {
  activeFilterCount,
  applyShopQuery,
  clearedShopQuery,
  DEFAULT_SHOP_QUERY,
  SHOP_PAGE_SIZE,
  SHOP_SORT_LABELS,
  SHOP_SORTS,
  shopQueryKey,
  toggleCategory,
  toggleOptionValue,
  withShopQuery,
  type ShopFacts,
  type ShopQuery,
  type ShopSort,
} from "@/lib/storefront/shop-filters";
import { buildShopFacets, facetValueLabel } from "@/lib/storefront/shop-facets";
import { shopFactsFor } from "@/lib/storefront/shop-product-facts";
import { colourCards, type ColourCard } from "@/lib/storefront/colour-cards";
import { formatPrice } from "@/lib/pricing";
import { ShopCard } from "@/app/(storefront)/components/shop-card";
import { useBrand } from "@/app/(storefront)/components/brand-provider";
import { ShopFilterPanel } from "./shop-filter-panel";
import { ShopFilterControls } from "./shop-filter-controls";

export interface ShopProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  image_url: string | null;
  images?: string[] | null;
  featured: boolean;
  sort_order: number;
  card_color: string | null;
  category?: string | null;
  created_at?: string | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  /** Option axes (jsonb), for the Size / Colour filters. */
  options?: unknown;
  variants: {
    id?: string;
    images?: string[] | null;
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

type Card = ColourCard<ShopProduct>;

export interface ShopCategory {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
  description?: string | null;
  image_url?: string | null;
}

type Props = {
  products: ShopProduct[];
  categories: ShopCategory[];
  /** The category this page is for (/collections/<slug>); absent on /shop. */
  collection?: ShopCategory;
  /** /shop?category=uncategorized — products with no category. */
  uncategorized?: boolean;
  // Optional ?q=<text> deep-link from the header search — filters the grid
  // by name/description match.
  initialQuery?: string;
  /** Sort, filters and revealed pages, read from the URL by the page. */
  initialShop?: ShopQuery;
  // Grocery theme: swap the WholeSip-branded hero/ticker for a clean header.
  grocery?: boolean;
  /** Shared toolbar, filters and "Load more"; enabled by default. */
  shopFilters?: boolean;
  /** Theme `layout.collectionBanner`: a collection's image + description. */
  collectionBanner?: boolean;
  // Store-wide default low-stock threshold (inventory.lowStockThreshold),
  // resolved by the page; drives each card's "Only X left" badge.
  storeLowStockThreshold?: number;
  /**
   * Per-product offer badge labels, keyed by product id, resolved on the
   * SERVER by `offerBadgeFor`.
   *
   * ★ A MAP OF ANSWERS, NOT THE OFFERS THEMSELVES. Shipping the offer list and
   * pricing each card in the browser would be a second implementation of the
   * engine on the one surface where being wrong is most visible — and it would
   * disagree with the server the moment `onSalePrice` or a special price
   * enters. The page resolves each product once and sends the label.
   */
  offerBadges?: Record<string, { label: string }>;
  /** Website Builder: one card per product, or one per colour. */
  productCards?: "product" | "colour";
};

const plural = (n: number) => `${n} ${n === 1 ? "product" : "products"}`;

export default function ShopClient({
  products,
  categories,
  collection,
  uncategorized = false,
  initialQuery,
  initialShop = DEFAULT_SHOP_QUERY,
  grocery = false,
  shopFilters = true,
  collectionBanner = false,
  storeLowStockThreshold = 0,
  offerBadges,
  productCards = "product",
}: Props) {
  const [query, setQuery] = useState<string>(initialQuery ?? "");
  const [shop, setShop] = useState<ShopQuery>(
    shopFilters ? initialShop : DEFAULT_SHOP_QUERY,
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const brand = useBrand();

  const basePath = collection ? collectionPath(collection.slug) : "/shop";

  // The grid's cards: one per product, or one per colour when the store asks
  // for it (lib/storefront/colour-cards.ts). Everything below — scope,
  // filters, counts, "Load more" — works on these cards.
  const cards = useMemo<Card[]>(
    () =>
      productCards === "colour"
        ? products.flatMap((p) => colourCards(p))
        : products.map((p) => ({
            key: p.id,
            product: p,
            href: null,
            colour: null,
          })),
    [products, productCards],
  );

  // What sorting and filtering read — the card's own price and stock rules,
  // per variant (lib/storefront/shop-product-facts.ts). Built once per load.
  const factsByCard = useMemo(() => {
    const slugById = new Map(categories.map((c) => [c.id, c.slug]));
    return new Map(cards.map((c) => [c, shopFactsFor(c.product, slugById)]));
  }, [cards, categories]);
  const factsOf = (c: Card): ShopFacts => factsByCard.get(c)!;
  // A collection (or "Other") is already one category, so it has no category
  // filter; /shop and search results do.
  const categoryChoices = useMemo(
    () =>
      collection || uncategorized
        ? null
        : categories.map((c) => ({ slug: c.slug, name: c.name })),
    [collection, uncategorized, categories],
  );

  // The header search and browser history can replace this SAME route without
  // remounting the client component. Adopt the complete server-parsed URL
  // state during render (React's "adjusting state when a prop changes"
  // pattern), so a filter absent from the new URL cannot survive invisibly.
  const incomingShop = shopFilters ? initialShop : DEFAULT_SHOP_QUERY;
  const incomingKey = `${initialQuery ?? ""}\u0000${shopQueryKey(incomingShop)}`;
  const [lastIncomingKey, setLastIncomingKey] = useState(incomingKey);
  if (lastIncomingKey !== incomingKey) {
    setLastIncomingKey(incomingKey);
    setQuery(initialQuery ?? "");
    setShop(incomingShop);
  }

  /**
   * ★ The URL is updated in place, not navigated. A sort or a filter is a
   * view of data this page already holds, so asking the server to render it
   * again would be a round trip for nothing — and the URL still ends up
   * shareable and restorable on reload.
   */
  const updateShop = (next: ShopQuery) => {
    setShop(next);
    const params = withShopQuery(
      new URLSearchParams(window.location.search),
      next,
    );
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  };

  // Scope first (collection, "Other", search), then the shopper's filters.
  const scoped = useMemo(() => {
    let list = cards;
    if (collection)
      list = list.filter((c) => c.product.category_id === collection.id);
    else if (uncategorized) list = list.filter((c) => !c.product.category_id);
    // The header's predictive search matches with the same function, so a
    // suggestion is always a product this grid shows for the same query.
    if (query.trim())
      list = list.filter((c) => matchesProductQuery(c.product, query));
    return list;
  }, [cards, collection, uncategorized, query]);

  const filtered = useMemo(
    () =>
      shopFilters
        ? applyShopQuery(scoped, shop, (c) => factsByCard.get(c)!)
        : scoped,
    [scoped, shop, shopFilters, factsByCard],
  );
  const shown = shopFilters
    ? filtered.slice(0, shop.pages * SHOP_PAGE_SIZE)
    : filtered;
  const facetsFor = (q: ShopQuery) =>
    buildShopFacets(scoped, q, factsOf, categoryChoices);
  const facetView = useMemo(
    () =>
      buildShopFacets(
        scoped,
        shop,
        (c) => factsByCard.get(c)!,
        categoryChoices,
      ),
    [scoped, shop, factsByCard, categoryChoices],
  );
  const sidebar = shopFilters && scoped.length > 0;
  const filterCount = activeFilterCount(shop);

  const clearQuery = () => {
    setQuery("");
    const qs = withShopQuery(new URLSearchParams(), shop).toString();
    router.replace(`${basePath}${qs ? `?${qs}` : ""}`);
  };
  const clearFilters = () => updateShop(clearedShopQuery(shop));

  const hasUncategorized = products.some((p) => !p.category_id);
  const trimmed = query.trim();
  const title = trimmed
    ? `Results for “${trimmed}”`
    : (collection?.name ?? (uncategorized ? "Other" : "Shop everything"));
  const banner =
    collectionBanner && collection && !trimmed
      ? {
          description: collection.description?.trim() || null,
          image: collection.image_url || null,
        }
      : null;

  const chip = (href: string, label: string, active: boolean, key: string) => (
    <Link
      key={key}
      href={href}
      className={`shop-chip${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      scroll={false}
    >
      {label}
    </Link>
  );

  return (
    <main className="shop-main shop-listing">
      <div className="shop-panel">
        <div className="shop-panel-body">
          {banner ? (
            <section
              className={`shop-collection-banner${banner.image ? " has-image" : ""}`}
            >
              <div className="shop-collection-text">
                <h1 className="shop-collection-title">{title}</h1>
                {banner.description && (
                  <p className="shop-collection-desc">{banner.description}</p>
                )}
              </div>
              {banner.image && (
                <div className="shop-collection-media">
                  <Image
                    src={banner.image}
                    alt=""
                    fill
                    priority
                    sizes="(max-width: 767px) 100vw, 50vw"
                    className="shop-collection-img"
                  />
                </div>
              )}
            </section>
          ) : grocery ? (
            /* Grocery gets a clean, brand-neutral header; the classic theme
               keeps the WholeSip lowercase-headline hero. */
            <section className="shop-hero shop-hero-grocery">
              <h1 className="shop-title-grocery">{title}</h1>
              <p className="shop-sub-grocery">
                {brand.tagline ||
                  brand.blurb ||
                  "Fresh picks, daily staples and pantry favourites."}
              </p>
            </section>
          ) : (
            <section className="shop-hero">
              <span className="shop-kicker">{brand.name}</span>
              <div className="shop-hero-row">
                <h1 className="shop-title">{title}</h1>
                {(brand.tagline || brand.blurb) && (
                  <div className="shop-note">
                    {brand.tagline || brand.blurb}
                  </div>
                )}
              </div>
            </section>
          )}

          {products.length === 0 ? (
            <div className="shop-empty">
              <div className="shop-empty-emoji">🛒</div>
              <h2>No products yet</h2>
              <p>Check back soon — we&rsquo;re stocking the shelves.</p>
            </div>
          ) : (
            <>
              {/* Each category is its own page, so a chip is a link: it can be
                  shared, opened in a new tab, and Back returns to it. */}
              <nav className="shop-filters" aria-label="Categories">
                {chip("/shop", "All", !collection && !uncategorized, "all")}
                {categories.map((c) =>
                  chip(
                    collectionPath(c.slug),
                    c.name,
                    collection?.id === c.id,
                    c.id,
                  ),
                )}
                {hasUncategorized &&
                  chip(
                    "/shop?category=uncategorized",
                    "Other",
                    uncategorized,
                    "uncategorized",
                  )}
              </nav>

              {/* Active search chip (from the header search / ?q= deep link) */}
              {trimmed && (
                <p className="shop-count">
                  Results for &ldquo;{trimmed}&rdquo;{" "}
                  <button
                    type="button"
                    className="shop-chip"
                    onClick={clearQuery}
                  >
                    Clear search
                  </button>
                </p>
              )}

              {shopFilters && scoped.length > 0 && (
                <div className="shop-toolbar">
                  <div className="shop-toolbar-start">
                    <button
                      ref={filterButtonRef}
                      type="button"
                      className={`shop-filter-btn${sidebar ? " has-sidebar" : ""}`}
                      aria-haspopup="dialog"
                      aria-expanded={filtersOpen}
                      onClick={() => setFiltersOpen(true)}
                    >
                      <SlidersHorizontal size={16} aria-hidden />
                      Filter
                      {filterCount > 0 && (
                        <span className="shop-filter-count">
                          {filterCount}
                          <span className="shop-sr-only"> active</span>
                        </span>
                      )}
                    </button>
                    {shop.categories.map((slug) => (
                      <button
                        key={`category:${slug}`}
                        type="button"
                        className="shop-active-filter"
                        onClick={() => updateShop(toggleCategory(shop, slug))}
                      >
                        {facetValueLabel(facetView, "category", slug)}
                        <X size={14} aria-hidden />
                        <span className="shop-sr-only"> — remove filter</span>
                      </button>
                    ))}
                    {Object.entries(shop.options).flatMap(([key, values]) =>
                      values.map((value) => (
                        <button
                          key={`${key}:${value}`}
                          type="button"
                          className="shop-active-filter"
                          onClick={() =>
                            updateShop(toggleOptionValue(shop, key, value))
                          }
                        >
                          {facetValueLabel(facetView, key, value)}
                          <X size={14} aria-hidden />
                          <span className="shop-sr-only"> — remove filter</span>
                        </button>
                      )),
                    )}
                    {shop.inStock && (
                      <button
                        type="button"
                        className="shop-active-filter"
                        onClick={() =>
                          updateShop({ ...shop, inStock: false, pages: 1 })
                        }
                      >
                        In stock
                        <X size={14} aria-hidden />
                        <span className="shop-sr-only"> — remove filter</span>
                      </button>
                    )}
                    {(shop.min !== null || shop.max !== null) && (
                      <button
                        type="button"
                        className="shop-active-filter"
                        onClick={() =>
                          updateShop({
                            ...shop,
                            min: null,
                            max: null,
                            pages: 1,
                          })
                        }
                      >
                        {shop.min !== null && shop.max !== null
                          ? `${formatPrice(shop.min)} – ${formatPrice(shop.max)}`
                          : shop.min !== null
                            ? `From ${formatPrice(shop.min)}`
                            : `Up to ${formatPrice(shop.max!)}`}
                        <X size={14} aria-hidden />
                        <span className="shop-sr-only"> — remove filter</span>
                      </button>
                    )}
                    {filterCount > 1 && (
                      <button
                        type="button"
                        className="shop-clear-filters"
                        onClick={clearFilters}
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                  <div className="shop-toolbar-end">
                    <span className="shop-toolbar-count" aria-live="polite">
                      {plural(filtered.length)}
                    </span>
                    <label className="shop-sort">
                      <span className="shop-sort-label">Sort by</span>
                      <select
                        aria-label="Sort by"
                        value={shop.sort}
                        onChange={(e) =>
                          updateShop({
                            ...shop,
                            sort: e.target.value as ShopSort,
                            pages: 1,
                          })
                        }
                      >
                        {SHOP_SORTS.map((s) => (
                          <option key={s} value={s}>
                            {SHOP_SORT_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              )}

              {/* ★ On a computer the filters are a sidebar that applies at
                  once; below 1024px the same controls open in the drawer.
                  CSS hides whichever does not apply. */}
              <div className={`shop-layout${sidebar ? " has-sidebar" : ""}`}>
                {sidebar && (
                  <aside className="shop-sidebar" aria-label="Filters">
                    <ShopFilterControls
                      query={shop}
                      view={facetView}
                      live
                      onChange={(next) => updateShop({ ...next, pages: 1 })}
                    />
                  </aside>
                )}
                <div className="shop-results">
                  {/* Product grid */}
                  {filtered.length === 0 ? (
                    <div className="shop-empty">
                      <p>
                        {scoped.length > 0 && filterCount > 0
                          ? "No products match these filters."
                          : trimmed
                            ? "No products match your search."
                            : "No products in this category yet."}
                      </p>
                      {scoped.length > 0 && filterCount > 0 && (
                        <button
                          type="button"
                          className="shop-chip"
                          onClick={clearFilters}
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {!shopFilters && (
                        <p className="shop-count">
                          Showing {filtered.length} of {plural(products.length)}
                        </p>
                      )}
                      <div className="shop-grid">
                        {shown.map((card) => (
                          <ShopCard
                            key={card.key}
                            product={card.product}
                            href={card.href}
                            colour={card.colour}
                            storeLowStockThreshold={storeLowStockThreshold}
                            headingLevel={2}
                            offerBadge={offerBadges?.[card.product.id]}
                          />
                        ))}
                      </div>
                      {shopFilters && (
                        <div className="shop-more">
                          <p className="shop-more-count" aria-live="polite">
                            Showing {shown.length} of {plural(filtered.length)}
                          </p>
                          {shown.length < filtered.length && (
                            <>
                              <div className="shop-more-bar" aria-hidden>
                                <span
                                  style={{
                                    width: `${(shown.length / filtered.length) * 100}%`,
                                  }}
                                />
                              </div>
                              <button
                                type="button"
                                className="shop-more-btn sm-btn-secondary"
                                onClick={() =>
                                  updateShop({ ...shop, pages: shop.pages + 1 })
                                }
                              >
                                Load more
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {shopFilters && filtersOpen && (
        <ShopFilterPanel
          value={shop}
          facetsFor={facetsFor}
          onApply={(next) => updateShop({ ...next, pages: 1 })}
          onClose={() => {
            setFiltersOpen(false);
            filterButtonRef.current?.focus();
          }}
        />
      )}
    </main>
  );
}
