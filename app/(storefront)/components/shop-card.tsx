import Link from "next/link";
import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { effectivePricing, formatPrice, type PricedLike } from "@/lib/pricing";
import { productIsSoldOut, productLowStockLeft } from "@/lib/inventory/status";
import { hoverImageUrl } from "@/lib/products/gallery";
import {
  guessSwatch,
  normalizeOptions,
  photoAxis,
  swatchAxis,
} from "@/lib/products/options";
import { QuickAddButton } from "./quick-add-button";
import { QuickViewButton } from "./quick-view-button";
import { WishlistButton } from "./wishlist-button";

// Card background falls back to this when a product has no card_color set.
// (Per-product colour is the source of truth.)
export const DEFAULT_CARD_BG = "#f4f2ee";

export type ShopCardProduct = Omit<PricedLike, "variants"> & {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  /** Rest of the gallery. Only [1] is used here — the hover image. Optional so
   *  a caller that has not been widened to select it simply gets no swap. */
  images?: string[] | null;
  featured?: boolean;
  card_color?: string | null;
  /** Resolved category name; shown as an eyebrow label when present. */
  category?: string | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  /** Option axes (jsonb) — the colour row under the price. */
  options?: unknown;
  variants?: {
    base_price: number;
    selling_price: number;
    special_price?: number | null;
    sort_order?: number;
    track_inventory: boolean;
    stock: number;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
  }[];
};

/** Colours shown before "+N". */
const CARD_SWATCHES = 4;

/** The colour row for a card: up to CARD_SWATCHES colours and a "+N". */
function colourRow(options: unknown) {
  const parsed = normalizeOptions(options);
  const list = "options" in parsed ? parsed.options : [];
  const photo = photoAxis(list);
  const axis = photo >= 0 ? photo : swatchAxis(list);
  if (axis < 0 || list[axis].values.length < 2) return null;
  const { values, swatches } = list[axis];
  return {
    name: list[axis].name,
    shown: values.slice(0, CARD_SWATCHES).map((value) => ({
      value,
      hex: swatches?.[value] ?? guessSwatch(value),
    })),
    more: Math.max(0, values.length - CARD_SWATCHES),
    total: values.length,
  };
}

// Single source of truth for the storefront product card — used by the shop
// grid and the homepage "featured products" section so styling stays in sync.
// `storeLowStockThreshold` is the store-wide default (inventory.lowStockThreshold)
// resolved per request by the rendering page; a per-SKU threshold overrides it.
export function ShopCard({
  product: p,
  storeLowStockThreshold = 0,
  headingLevel = 3,
  offerBadge,
  href,
  colour,
}: {
  product: ShopCardProduct;
  storeLowStockThreshold?: number;
  /**
   * A line-level offer's saving on THIS product, from `offerBadgeFor`.
   *
   * ★ OPTIONAL, so every existing call site (homepage sections, related
   * carousels, search) keeps working untouched and simply shows no badge —
   * a card that renders a stale or absent offer is worse than one that renders
   * none. Pass it from a page that has already loaded the store's offers.
   */
  offerBadge?: { label: string } | null;
  /** Shop grids sit directly below the page h1; homepage/related carousels
   * sit below a section h2. Keep the shared card's heading hierarchy valid in
   * both contexts. */
  headingLevel?: 2 | 3;
  /** A per-colour card's link (`?variant=…`); the product page otherwise. */
  href?: string | null;
  /** The colour a per-colour card shows. */
  colour?: string | null;
}) {
  const pr = effectivePricing(p);
  const NameHeading = headingLevel === 2 ? "h2" : "h3";

  // The second photograph, cross-faded in on hover. Rendered ONLY when one
  // exists — see the `.sm-card-hoverimg` note in storefront-theme.css for why
  // this is a real conditional render rather than the render-always-and-hide-
  // with-CSS approach QuickAddButton uses.
  const hoverSrc = hoverImageUrl(p.image_url, p.images);

  // Stock status via the shared resolver so cards, the detail page, and the
  // dashboard agree (sold-out wins over low; low uses the effective threshold).
  const variants = p.variants ?? [];
  const isOutOfStock = productIsSoldOut(variants, p);
  const lowStockAmount = isOutOfStock
    ? null
    : productLowStockLeft(variants, p, storeLowStockThreshold);
  const isLowStock = lowStockAmount !== null;
  const colours = colourRow(p.options);

  return (
    <Link
      href={href ?? `/shop/${p.slug}`}
      className="shop-card"
      style={
        { "--card-bg": p.card_color || DEFAULT_CARD_BG } as React.CSSProperties
      }
    >
      <div className="shop-card-img">
        {/* Hidden unless the store keeps its wishlist (.sm-wishlist). */}
        <WishlistButton slug={p.slug} name={p.name} />
        {/* Hidden unless the store keeps its quick view (.sm-quickview). */}
        <QuickViewButton productId={p.id} name={p.name} href={href} />
        {p.image_url ? (
          <>
            <Image
              src={p.image_url}
              alt={colour ? `${p.name}, ${colour}` : p.name}
              fill
              sizes="(max-width: 768px) 50vw, 280px"
              className="shop-card-img-el"
            />
            {hoverSrc && (
              <span className="shop-card-img-hover" aria-hidden>
                <Image
                  src={hoverSrc}
                  alt=""
                  fill
                  sizes="(max-width: 768px) 50vw, 280px"
                  loading="lazy"
                  className="shop-card-img-el"
                />
              </span>
            )}
          </>
        ) : (
          <div className="shop-card-img-placeholder">
            <ImageIcon size={28} strokeWidth={1.5} aria-hidden />
          </div>
        )}
        {/* ★ ONE FLAG ON THE PHOTO. Stock outranks the offer, always:
            "20% off" beside "Sold out" invites a shopper to try to buy
            something they cannot. The plain markdown flag ("Save 8%") is the
            classic card's; other card styles keep their "% off" price pill
            and hide it (storefront-theme.css). */}
        {isOutOfStock ? (
          <span className="shop-card-flag shop-card-flag--soldout">
            Sold out
          </span>
        ) : isLowStock ? (
          <span className="shop-card-flag shop-card-flag--lowstock">
            Only {lowStockAmount} left
          </span>
        ) : offerBadge ? (
          <span className="shop-card-flag shop-card-flag--offer">
            {offerBadge.label}
          </span>
        ) : pr.discount > 0 ? (
          <span className="shop-card-flag shop-card-flag--save">
            Save {pr.discount}%
          </span>
        ) : null}
      </div>

      <div className="shop-card-body">
        <div className="shop-card-head">
          {p.category && <span className="shop-card-cat">{p.category}</span>}
          <NameHeading className="shop-card-name">
            {p.name}
            {colour && <span className="sr-only">, {colour}</span>}
          </NameHeading>
        </div>
        <div className="shop-card-price">
          {/* "from", then the MRP struck through, then what they pay — the
              order a shopper reads a markdown in. "from" leads whichever group
              comes first so it never lands between the two prices. */}
          {pr.discount > 0 && (
            <span className="shop-card-deal">
              {pr.hasVariants && <span className="shop-card-from">from </span>}
              <span className="shop-card-base">
                <span className="sr-only">Was </span>
                {formatPrice(pr.base)}
              </span>
            </span>
          )}
          <span className="shop-card-current">
            {pr.hasVariants && pr.discount <= 0 && (
              <span className="shop-card-from">from </span>
            )}
            <span
              className={
                pr.discount > 0
                  ? "shop-card-sell shop-card-sell--sale"
                  : "shop-card-sell"
              }
            >
              {pr.discount > 0 && <span className="sr-only">Now </span>}
              {formatPrice(pr.selling)}
            </span>
          </span>
          {pr.discount > 0 && (
            <span className="shop-card-off">{pr.discount}% off</span>
          )}
          {/* Hidden unless the theme opts into quick-add (.sm-card-quickadd). */}
          <QuickAddButton product={p} />
        </div>
        {colours && (
          <div className="shop-card-colours">
            <span className="sr-only">
              Available in {colours.total} {colours.name.toLowerCase()}s
            </span>
            {colours.shown.map((c) => (
              <span
                key={c.value}
                className={`shop-card-colour${
                  colour === c.value ? " is-current" : ""
                }`}
                style={{ background: c.hex }}
                title={c.value}
                aria-hidden
              />
            ))}
            {colours.more > 0 && (
              <span className="shop-card-colour-more" aria-hidden>
                +{colours.more}
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
