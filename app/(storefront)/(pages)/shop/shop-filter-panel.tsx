"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  clearedShopQuery,
  type ShopQuery,
} from "@/lib/storefront/shop-filters";
import type { ShopFacetView } from "@/lib/storefront/shop-facets";
import { ShopFilterControls } from "./shop-filter-controls";

// ---------------------------------------------------------------------------
// The shop's filter panel — a side drawer on a tablet, a bottom sheet on a
// phone (CSS decides; the markup is one dialog). A computer shows the same
// controls in a sidebar instead (shop-client.tsx).
//
// ★ CHANGES ARE A DRAFT UNTIL "SHOW N PRODUCTS". Applying each keystroke would
// re-sort the grid behind the panel while somebody is still typing "1500" —
// three filters in a row, the middle two meaningless. The button quotes how
// many products the draft would show, so nobody commits to an empty page
// blind; closing the panel any other way discards the draft.
//
// ★ PORTALLED INTO `.storefront-root`, the quick-add dialog's rule: the
// theme's palette and radii are inline variables there, and document.body
// would render the panel in the fallback look.
// ---------------------------------------------------------------------------

export function ShopFilterPanel({
  value,
  facetsFor,
  onApply,
  onClose,
}: {
  value: ShopQuery;
  /** Filter lists and counts for a draft. */
  facetsFor: (draft: ShopQuery) => ShopFacetView;
  onApply: (next: ShopQuery) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<ShopQuery>(value);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const view = facetsFor(draft);
  const count = view.total;

  // Escape closes, Tab stays inside, the page behind does not scroll, and
  // focus starts on the panel (the caller returns it to "Filter").
  useEffect(() => {
    const dialog = dialogRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, []);

  const root =
    document.querySelector<HTMLElement>(".storefront-root") ?? document.body;

  return createPortal(
    <div className="shop-filter-layer">
      <div className="shop-filter-backdrop" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        className="shop-filter-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="shop-filter-head">
          <h2 id={titleId}>Filter</h2>
          <button
            type="button"
            className="shop-filter-close"
            onClick={onClose}
            aria-label="Close filters"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        <div className="shop-filter-body">
          <ShopFilterControls
            query={draft}
            view={view}
            live={false}
            onChange={setDraft}
          />
        </div>

        <div className="shop-filter-foot">
          <button
            type="button"
            className="shop-filter-reset"
            onClick={() => setDraft(clearedShopQuery(draft))}
          >
            Clear
          </button>
          <button
            type="button"
            className="shop-filter-apply"
            onClick={() => {
              // A backwards range means what it obviously means.
              const swapped =
                draft.min !== null &&
                draft.max !== null &&
                draft.min > draft.max
                  ? { ...draft, min: draft.max, max: draft.min }
                  : draft;
              onApply(swapped);
              onClose();
            }}
          >
            Show {count} {count === 1 ? "product" : "products"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
