"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  pageNumbers,
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
import {
  defaultTemplates,
  type CollectionTemplate,
  type PromoTile,
} from "@/lib/themes/templates";
import { ShopCard } from "@/app/(storefront)/components/shop-card";
import { useBrand } from "@/app/(storefront)/components/brand-provider";
import { ShopFilterPanel } from "./shop-filter-panel";
import { ShopFilterBar, ShopFilterControls } from "./shop-filter-controls";

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
  /**
   * The collection page's composition (plan Phase 2e, lib/themes/templates.ts):
   * where the filters live (the sidebar, the drawer alone, or a row of
   * popovers above the grid), how the grid pages (Load more, numbered pages,
   * or revealing as the shopper scrolls) and the promotional tiles placed
   * among the cards. Resolved by the page from the theme and the merchant's
   * override; the default is the page exactly as it was.
   */
  collectionTemplate?: CollectionTemplate;
};

const DEFAULT_COLLECTION_TEMPLATE = defaultTemplates(undefined).collection;

/** Only an image the optimiser is configured for goes through it; a
 *  merchant's pasted link elsewhere is served as it is. */
const optimisable = (url: string) =>
  url.startsWith("/") ||
  url.startsWith("https://storage.googleapis.com/") ||
  url.startsWith("https://images.unsplash.com/");

/** A theme's promotional tile among the cards: a colour field or a picture
 *  with the copy over its lower edge, the whole tile the link. */
function PromoTileCard({ tile }: { tile: PromoTile }) {
  const className = `shop-promo-tile theme-${tile.theme}${
    tile.image_url ? " has-image" : ""
  }`;
  const style = tile.background ? { background: tile.background } : undefined;
  const inner = (
    <>
      {tile.image_url && (
        <Image
          src={tile.image_url}
          alt={tile.image_alt}
          fill
          sizes="(max-width: 640px) 100vw, 33vw"
          className="shop-promo-tile-img"
          unoptimized={!optimisable(tile.image_url)}
        />
      )}
      <div className="shop-promo-tile-copy">
        {tile.heading && <h2>{tile.heading}</h2>}
        {tile.body && <p>{tile.body}</p>}
        {tile.cta_label && tile.href && (
          <span className="shop-promo-tile-cta">{tile.cta_label}</span>
        )}
      </div>
    </>
  );
  return tile.href ? (
    <Link href={tile.href} className={className} style={style}>
      {inner}
    </Link>
  ) : (
    <div className={className} style={style}>
      {inner}
    </div>
  );
}

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
  collectionTemplate = DEFAULT_COLLECTION_TEMPLATE,
}: Props) {
  const [query, setQuery] = useState<string>(initialQuery ?? "");
  const filtersMode = collectionTemplate.filters;
  const paging = collectionTemplate.pagination;
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
  // Numbered pages show one page; Load more and the scrolling reveal show
  // every page up to the current one. A page past the end (filters narrowed
  // the list under a shared link) shows the last page rather than nothing.
  const pageCount = Math.max(1, Math.ceil(filtered.length / SHOP_PAGE_SIZE));
  const page =
    paging === "paged" ? Math.min(shop.pages, pageCount) : shop.pages;
  const offset = paging === "paged" ? (page - 1) * SHOP_PAGE_SIZE : 0;
  const shown = shopFilters
    ? paging === "paged"
      ? filtered.slice(offset, offset + SHOP_PAGE_SIZE)
      : filtered.slice(0, shop.pages * SHOP_PAGE_SIZE)
    : filtered;
  const more =
    shopFilters && paging !== "paged" && shown.length < filtered.length;
  // The theme's tiles sit after the Nth card of the whole list, so one lands
  // on whichever page holds that card and nowhere else.
  const gridItems = useMemo(() => {
    const items: (
      | { kind: "card"; card: (typeof shown)[number] }
      | {
          kind: "tile";
          tile: PromoTile;
          key: string;
        }
    )[] = shown.map((card) => ({ kind: "card", card }));
    const tiles = [...collectionTemplate.promoTiles]
      .map((tile, index) => ({ tile, key: `tile-${index}` }))
      .filter(
        ({ tile }) =>
          tile.afterIndex > offset && tile.afterIndex <= offset + shown.length,
      )
      .sort((a, b) => b.tile.afterIndex - a.tile.afterIndex);
    for (const { tile, key } of tiles) {
      items.splice(tile.afterIndex - offset, 0, { kind: "tile", tile, key });
    }
    return items;
  }, [shown, collectionTemplate.promoTiles, offset]);
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
  const sidebar = shopFilters && scoped.length > 0 && filtersMode === "sidebar";
  const topBar = shopFilters && scoped.length > 0 && filtersMode === "top-bar";
  const filterCount = activeFilterCount(shop);
  const gridRef = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => {
    updateShop({ ...shop, pages: next });
    // Back to the top of the grid, as turning a page does; jsdom has no
    // scrollIntoView, hence the optional call.
    gridRef.current?.scrollIntoView?.({ block: "start" });
  };

  // Infinite reveal: a sentinel under the grid asks for the next page as it
  // comes into view. The Load more button stays beneath it, so a browser
  // without IntersectionObserver, a keyboard and a screen reader keep a way
  // to the rest.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const shopRef = useRef(shop);
  // Kept current from an effect, never during render (react-hooks/refs);
  // it runs before the observer effect below on every commit.
  useEffect(() => {
    shopRef.current = shop;
  }, [shop]);
  useEffect(() => {
    if (paging !== "infinite" || !more) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        const current = shopRef.current;
        updateShop({ ...current, pages: current.pages + 1 });
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
    // The deps that change the answer are the mode and whether there is
    // more to reveal; the query itself is read through the ref.
  }, [paging, more, shown.length]);

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
              <p>Check back soon - we&rsquo;re stocking the shelves.</p>
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
                      className={`shop-filter-btn${sidebar ? " has-sidebar" : ""}${topBar ? " has-topbar" : ""}`}
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
                        <span className="shop-sr-only"> - remove filter</span>
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
                          <span className="shop-sr-only"> - remove filter</span>
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
                        <span className="shop-sr-only"> - remove filter</span>
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
                          ? `${formatPrice(shop.min)} to ${formatPrice(shop.max)}`
                          : shop.min !== null
                            ? `From ${formatPrice(shop.min)}`
                            : `Up to ${formatPrice(shop.max!)}`}
                        <X size={14} aria-hidden />
                        <span className="shop-sr-only"> - remove filter</span>
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
                  {topBar && (
                    <ShopFilterBar
                      query={shop}
                      view={facetView}
                      onChange={(next) => updateShop({ ...next, pages: 1 })}
                    />
                  )}
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
                      <div className="shop-grid" ref={gridRef}>
                        {gridItems.map((item) =>
                          item.kind === "tile" ? (
                            <PromoTileCard key={item.key} tile={item.tile} />
                          ) : (
                            <ShopCard
                              key={item.card.key}
                              product={item.card.product}
                              href={item.card.href}
                              colour={item.card.colour}
                              storeLowStockThreshold={storeLowStockThreshold}
                              headingLevel={2}
                              offerBadge={offerBadges?.[item.card.product.id]}
                            />
                          ),
                        )}
                      </div>
                      {shopFilters && paging === "paged" && (
                        <nav className="shop-pages" aria-label="Pages">
                          <p className="shop-pages-count" aria-live="polite">
                            Showing {offset + 1} to {offset + shown.length} of{" "}
                            {plural(filtered.length)}
                          </p>
                          {pageCount > 1 && (
                            <>
                              <button
                                type="button"
                                disabled={page <= 1}
                                onClick={() => goToPage(page - 1)}
                              >
                                Previous
                              </button>
                              {pageNumbers(page, pageCount).map((n, i) =>
                                n === null ? (
                                  <span
                                    key={`gap-${i}`}
                                    className="shop-pages-gap"
                                    aria-hidden
                                  >
                                    …
                                  </span>
                                ) : (
                                  <button
                                    key={n}
                                    type="button"
                                    aria-current={
                                      n === page ? "page" : undefined
                                    }
                                    aria-label={`Page ${n}`}
                                    onClick={() => n !== page && goToPage(n)}
                                  >
                                    {n}
                                  </button>
                                ),
                              )}
                              <button
                                type="button"
                                disabled={page >= pageCount}
                                onClick={() => goToPage(page + 1)}
                              >
                                Next
                              </button>
                            </>
                          )}
                        </nav>
                      )}
                      {shopFilters && paging !== "paged" && (
                        <div className="shop-more">
                          {paging === "infinite" && more && (
                            <div
                              ref={sentinelRef}
                              className="shop-more-sentinel"
                              aria-hidden
                            />
                          )}
                          <p className="shop-more-count" aria-live="polite">
                            Showing {shown.length} of {plural(filtered.length)}
                          </p>
                          {more && (
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
