"use client";

import { useSyncExternalStore } from "react";
import {
  readDeviceList,
  serverDeviceList,
  subscribeDeviceLists,
  toggleSaved,
} from "@/lib/storefront/device-lists";

// The heart that saves a product for later (owner, 22 Nov 2026). The list
// lives on the shopper's device (lib/storefront/device-lists.ts), so it works
// without an account and nothing is sent anywhere when it is pressed.
//
// ★ Rendered by every product card and hidden by CSS unless the storefront
//   root has `.sm-wishlist` (the merchant's switch), the way the quick-add
//   button is: a hidden control costs nothing, and the builder can show and
//   hide it live.
// ★ On a card it sits inside the card's link, so it is a `role="button"`
//   element that stops the click from following the link (QuickAddButton's
//   own approach); on the product page it is a real button with words.
// ★ The server renders every heart unsaved: nobody's list is known there.

const saved = () => readDeviceList("wishlist");

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  );
}

export function WishlistButton({
  slug,
  name,
  variant = "card",
}: {
  slug: string;
  name: string;
  /** "card": the round heart over a card's photo. "page": a labelled button. */
  variant?: "card" | "page";
}) {
  const isSaved = useSyncExternalStore(
    subscribeDeviceLists,
    saved,
    serverDeviceList,
  ).includes(slug);
  const label = isSaved
    ? `Remove ${name} from saved items`
    : `Save ${name} for later`;
  const press = (event: {
    preventDefault(): void;
    stopPropagation(): void;
  }) => {
    // Never the card's link: saving a product is not opening it.
    event.preventDefault();
    event.stopPropagation();
    toggleSaved(slug);
  };

  if (variant === "page") {
    return (
      <button
        type="button"
        className="pdp-wish"
        aria-pressed={isSaved}
        data-saved={isSaved}
        onClick={press}
      >
        <Heart filled={isSaved} />
        <span>{isSaved ? "Saved" : "Save for later"}</span>
        <span className="sr-only">: {name}</span>
      </button>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className="shop-card-wish"
      aria-pressed={isSaved}
      aria-label={label}
      data-saved={isSaved}
      onClick={press}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") press(event);
      }}
    >
      <Heart filled={isSaved} />
    </span>
  );
}
