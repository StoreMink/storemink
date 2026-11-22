"use client";

import { useCallback, useState } from "react";
import { QuickViewDialog } from "./quick-view-dialog";

// The eye on a product card that opens the quick view (owner, 22 Nov 2026).
//
// ★ Rendered by every product card and hidden by CSS unless the storefront
//   root has `.sm-quickview` (the merchant's switch, on unless they turn it
//   off), the way the wishlist heart and the quick-add button are: a hidden
//   control costs nothing, and the builder can show and hide it live.
// ★ It sits inside the card's link, so it is a `role="button"` element that
//   stops the click from following the link (the heart's own approach).
// ★ The dialog, and the product it reads, exist only while it is open: a
//   grid of sixty cards loads nothing for sixty quick views nobody asked for.

/** The variant a per-colour card links to (`/shop/slug?variant=...`). */
export function variantOfHref(href: string | null | undefined): string | null {
  const query = href?.split("?")[1]?.split("#")[0];
  if (!query) return null;
  return new URLSearchParams(query).get("variant") || null;
}

function Eye() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function QuickViewButton({
  productId,
  name,
  href,
}: {
  productId: string;
  name: string;
  /** The card's own link, read for the variant a per-colour card shows. */
  href?: string | null;
}) {
  // The eye while the quick view is open; null when it is closed.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const open = (event: {
    currentTarget: HTMLElement;
    preventDefault(): void;
    stopPropagation(): void;
  }) => {
    // Never the card's link: looking closer is not leaving the page.
    event.preventDefault();
    event.stopPropagation();
    setAnchor(event.currentTarget);
  };

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className="shop-card-view"
        aria-haspopup="dialog"
        aria-label={`Quick view: ${name}`}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") open(event);
        }}
      >
        <Eye />
      </span>
      {anchor && (
        <QuickViewDialog
          productId={productId}
          anchor={anchor}
          requestedVariantId={variantOfHref(href)}
          onClose={close}
        />
      )}
    </>
  );
}
