"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { ImageIcon, X } from "lucide-react";
import { toast } from "sonner";
import {
  discountPercent,
  effectivePricing,
  formatPrice,
  variantEffectiveSelling,
} from "@/lib/pricing";
import { cartLineMax, isSoldOut } from "@/lib/inventory/status";
import {
  initialVariant,
  photosForVariant,
  usesOptionPickers,
} from "@/lib/products/options";
import {
  getQuickViewProduct,
  type QuickAddVariant,
  type QuickViewProduct,
} from "@/app/actions/quick-add-actions";
import { lineKey, useCart } from "./cart/CartProvider";
import { OptionPicker } from "./option-picker";
import { WishlistButton } from "./wishlist-button";

// ---------------------------------------------------------------------------
// Quick view (owner, 22 Nov 2026): the eye on a product card opens the
// product over the page the shopper is on. Its photographs, price, the first
// lines of its description, the size and colour pickers and Add to cart, so
// looking closer at a product no longer costs the grid and the scroll
// position.
//
// It follows the quick-add chooser's two rules (quick-add-dialog.tsx), for
// the same reasons:
// ★ PORTALLED INTO `.storefront-root`, NOT document.body: the theme's
//   palette, type and radii are CSS variables on that element.
// ★ Its root STOPS PROPAGATION: React bubbles synthetic events through a
//   portal to the component tree, and the tree here is a card's <Link>.
//
// And adds one the chooser does not have:
// ★ TAB STAYS INSIDE. This dialog holds a dozen controls and covers the
//   page, so focus that walked out of it would land on cards nobody can see.
// ---------------------------------------------------------------------------

/** Thumbnails shown; a product with more keeps them for its own page. */
export const QUICK_VIEW_THUMBS = 8;

const FOCUSABLE =
  'a[href], button:not([disabled]), [role="button"][tabindex]:not([tabindex="-1"])';

function sellingOf(v: QuickAddVariant): number {
  const eff = variantEffectiveSelling(v);
  return eff > 0 ? eff : v.base_price;
}

export function QuickViewDialog({
  productId,
  anchor,
  requestedVariantId = null,
  onClose,
}: {
  productId: string;
  /** The eye that opened it; focus returns there on close. */
  anchor: HTMLElement | null;
  /** The variant a per-colour card stands for, when it is one. */
  requestedVariantId?: string | null;
  onClose: () => void;
}) {
  const { addItem, items } = useCart();
  const [product, setProduct] = useState<QuickViewProduct | null>(null);
  const [failed, setFailed] = useState(false);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [activeImg, setActiveImg] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    let live = true;
    getQuickViewProduct(productId)
      .then((p) => {
        if (!live) return;
        if (!p) {
          setFailed(true);
          return;
        }
        const opening =
          initialVariant(
            p.variants.map((v) => ({ ...v, available: !isSoldOut(v) })),
            requestedVariantId,
          ) ?? null;
        setProduct(p);
        setVariantId(opening?.id ?? null);
        setActiveImg(
          photosForVariant(p.options, opening)[0] ?? p.gallery[0] ?? null,
        );
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [productId, requestedVariantId]);

  // Escape closes, Tab stays inside, the page behind does not scroll, and
  // focus moves into the dialog and back to the eye afterwards. The latest
  // onClose is read through a ref so this runs once per opening, never again
  // (bouncing focus) because the parent re-rendered.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = dialogRef.current;
      if (!panel) return;
      // A control the stylesheet hides (the save button of a store with no
      // wishlist) is no stop.
      const stops = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => window.getComputedStyle(el).display !== "none");
      if (stops.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !panel.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      anchor?.focus();
    };
  }, [anchor]);

  const pickable = useMemo(
    () =>
      (product?.variants ?? []).map((v) => ({
        ...v,
        available: !isSoldOut(v),
      })),
    [product],
  );
  const hasVariants = pickable.length > 0;
  const selected = pickable.find((v) => v.id === variantId) ?? null;
  const pickers =
    product !== null &&
    hasVariants &&
    usesOptionPickers(product.options, pickable);

  // The photographs shown: the chosen variant's own, else its colour's, else
  // the product's (the product page's rule, product-detail-client.tsx).
  const variantImages = photosForVariant(product?.options ?? [], selected);
  const gallery = (
    variantImages.length > 0
      ? Array.from(new Set(variantImages))
      : (product?.gallery ?? [])
  ).slice(0, QUICK_VIEW_THUMBS);
  const shown =
    activeImg && gallery.includes(activeImg) ? activeImg : (gallery[0] ?? null);

  const selectVariant = (id: string) => {
    setVariantId(id);
    const next = pickable.find((v) => v.id === id) ?? null;
    setActiveImg(
      photosForVariant(product?.options ?? [], next)[0] ??
        product?.gallery[0] ??
        null,
    );
  };

  // What is being bought: the chosen variant, or the product itself when it
  // is sold without variants.
  const price = !product
    ? null
    : hasVariants
      ? selected && {
          selling: sellingOf(selected),
          base: selected.base_price,
          discount: discountPercent(selected.base_price, sellingOf(selected)),
        }
      : effectivePricing({
          base_price: product.base_price,
          selling_price: product.selling_price,
        });
  const stockOf = hasVariants ? selected : product;
  const soldOut = !stockOf || isSoldOut(stockOf);

  const add = () => {
    if (!product || !price || !stockOf || soldOut) return;
    const variant = hasVariants ? selected : null;
    const snapshot = {
      trackInventory: stockOf.track_inventory,
      stock: stockOf.stock,
      allowBackorder: stockOf.allow_backorder,
    };
    const label = variant ? `${product.name} (${variant.name})` : product.name;
    // Say so when the cart already holds every one there is: the cart would
    // quietly refuse, and a button that does nothing reads as broken.
    const max = cartLineMax(snapshot);
    const inCart =
      items.find(
        (i) =>
          lineKey(i.productId, i.variantId) ===
          lineKey(product.id, variant?.id ?? null),
      )?.quantity ?? 0;
    if (inCart >= max) {
      toast.error(`Only ${max} of ${label} available - already in your cart.`, {
        duration: 2200,
      });
      return;
    }
    addItem({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      variantId: variant?.id ?? null,
      variantName: variant?.name ?? null,
      price: price.selling,
      basePrice: price.base,
      image: shown ?? product.image_url,
      category: product.category,
      ...snapshot,
    });
    toast.success(`${label} added to cart`, { duration: 1800 });
    onClose();
  };

  const root =
    anchor?.closest<HTMLElement>(".storefront-root") ?? document.body;

  return createPortal(
    <div
      className="sm-qv"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={product ? titleId : undefined}
        aria-label={product ? undefined : "Quick view"}
        tabIndex={-1}
        className="sm-qv-panel"
      >
        <button
          type="button"
          className="sm-qv-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>

        {failed ? (
          <p className="sm-qv-msg">
            This product could not be loaded. Please try again.
          </p>
        ) : !product ? (
          <p className="sm-qv-msg" aria-live="polite">
            Loading product…
          </p>
        ) : (
          <div className="sm-qv-grid">
            <div className="sm-qv-media">
              <div className="sm-qv-photo">
                {shown ? (
                  <Image
                    src={shown}
                    alt={product.name}
                    fill
                    sizes="(max-width: 767px) 100vw, 420px"
                  />
                ) : (
                  <span className="sm-qv-nophoto">
                    <ImageIcon size={32} strokeWidth={1.5} aria-hidden />
                  </span>
                )}
              </div>
              {gallery.length > 1 && (
                <div className="sm-qv-thumbs" role="group" aria-label="Photos">
                  {gallery.map((src, index) => (
                    <button
                      key={src}
                      type="button"
                      className={`sm-qv-thumb${
                        src === shown ? " is-active" : ""
                      }`}
                      aria-label={`Photo ${index + 1} of ${gallery.length}`}
                      aria-pressed={src === shown}
                      onClick={() => setActiveImg(src)}
                    >
                      <Image src={src} alt="" fill sizes="64px" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="sm-qv-info">
              {product.category && (
                <p className="sm-qv-cat">{product.category}</p>
              )}
              <h2 id={titleId} className="sm-qv-name">
                {product.name}
              </h2>
              {price && (
                <p className="sm-qv-price">
                  {price.discount > 0 && <span className="sr-only">Now </span>}
                  {formatPrice(price.selling)}
                  {price.discount > 0 && (
                    <>
                      <span className="sm-qv-was">
                        <span className="sr-only">Was </span>
                        {formatPrice(price.base)}
                      </span>
                      <span className="sm-qv-off">{price.discount}% off</span>
                    </>
                  )}
                </p>
              )}
              {product.excerpt && (
                <p className="sm-qv-text">{product.excerpt}</p>
              )}

              {hasVariants &&
                (pickers ? (
                  <OptionPicker
                    options={product.options}
                    variants={pickable}
                    selectedId={variantId}
                    onSelect={(v) => selectVariant(v.id)}
                  />
                ) : (
                  <div className="sm-opts">
                    <fieldset className="sm-opt">
                      <legend className="sm-opt-legend">Options</legend>
                      <div className="sm-opt-values">
                        {pickable.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            aria-pressed={v.id === variantId}
                            className={`sm-opt-value${
                              v.id === variantId ? " is-active" : ""
                            }${v.available ? "" : " is-unavailable"}`}
                            onClick={() => selectVariant(v.id)}
                          >
                            {v.name}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                ))}

              <button
                type="button"
                className="sm-qv-add"
                disabled={soldOut}
                onClick={add}
              >
                {soldOut ? "Sold out" : "Add to cart"}
              </button>
              {/* Shown only while the store keeps its wishlist (.sm-wishlist). */}
              <WishlistButton
                slug={product.slug}
                name={product.name}
                variant="page"
              />
              <Link
                href={`/shop/${product.slug}${
                  selected ? `?variant=${selected.id}` : ""
                }`}
                className="sm-qv-details"
                onClick={onClose}
              >
                View full details
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>,
    root,
  );
}
