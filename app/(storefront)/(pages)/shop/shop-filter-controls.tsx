"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import {
  toggleCategory,
  toggleOptionValue,
  type ShopQuery,
} from "@/lib/storefront/shop-filters";
import type { Facet, ShopFacetView } from "@/lib/storefront/shop-facets";

// ---------------------------------------------------------------------------
// The filter groups themselves — rendered by the desktop sidebar (every change
// applies at once) and the phone drawer (changes are a draft until "Show N").
// One component, so the two can never offer different filters.
//
// ★ A VALUE THAT WOULD SHOW NOTHING IS GREYED, NOT HIDDEN — unless ticked, so
// it can always be unticked. Hiding it would make the list jump as the
// shopper works through it.
// ★ PRICE COMMITS ON BLUR OR ENTER in live mode: re-filtering the grid on each
// keystroke of "1500" would apply 1, 15 and 150 on the way.
// ---------------------------------------------------------------------------

/** Values shown before "Show more". */
const COLLAPSED_VALUES = 8;

function toBound(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function ShopFilterControls({
  query,
  view,
  onChange,
  live,
}: {
  query: ShopQuery;
  view: ShopFacetView;
  onChange: (next: ShopQuery) => void;
  /** Sidebar: true (apply now). Drawer: false (a draft). */
  live: boolean;
}) {
  return (
    <div className="shop-facets">
      {view.facets
        .filter((f) => f.key === "category")
        .map((facet) => (
          <FacetGroup
            key={facet.key}
            facet={facet}
            onToggle={(value) => onChange(toggleCategory(query, value))}
          />
        ))}

      <Group title="Availability" selected={query.inStock ? 1 : 0}>
        <label className="shop-filter-check">
          <input
            type="checkbox"
            checked={query.inStock}
            disabled={!query.inStock && view.inStockCount === 0}
            onChange={(e) =>
              onChange({ ...query, inStock: e.target.checked, pages: 1 })
            }
          />
          <span>In stock only</span>
          <span className="shop-filter-muted">({view.inStockCount})</span>
        </label>
      </Group>

      {view.facets
        .filter((f) => f.key !== "category")
        .map((facet) => (
          <FacetGroup
            key={facet.key}
            facet={facet}
            onToggle={(value) =>
              onChange(toggleOptionValue(query, facet.key, value))
            }
          />
        ))}

      <PriceGroup
        query={query}
        span={view.span}
        live={live}
        onChange={onChange}
      />
    </div>
  );
}

function Group({
  title,
  selected,
  children,
}: {
  title: string;
  selected: number;
  children: React.ReactNode;
}) {
  return (
    <details className="shop-filter-group" open>
      <summary>
        <span>{title}</span>
        {selected > 0 && (
          <span className="shop-filter-selected">
            {selected}
            <span className="shop-sr-only"> selected</span>
          </span>
        )}
      </summary>
      <div className="shop-filter-group-body">{children}</div>
    </details>
  );
}

function FacetGroup({
  facet,
  onToggle,
}: {
  facet: Facet;
  onToggle: (valueKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = facet.values.length - COLLAPSED_VALUES;
  // A ticked value is always visible, even beyond the fold.
  const values =
    expanded || hidden <= 0
      ? facet.values
      : facet.values.filter((v, i) => i < COLLAPSED_VALUES || v.selected);

  return (
    <Group title={facet.label} selected={facet.selectedCount}>
      {facet.kind === "size" ? (
        <div
          className="shop-filter-pills"
          role="group"
          aria-label={facet.label}
        >
          {values.map((v) => (
            <button
              key={v.key}
              type="button"
              className="shop-filter-pill"
              aria-pressed={v.selected}
              disabled={!v.selected && v.count === 0}
              onClick={() => onToggle(v.key)}
              title={`${v.label} (${v.count})`}
            >
              {v.label}
              <span className="shop-sr-only">
                , {v.count} {v.count === 1 ? "product" : "products"}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <ul className="shop-filter-list">
          {values.map((v) => (
            <li key={v.key}>
              <label className="shop-filter-check">
                <input
                  type="checkbox"
                  checked={v.selected}
                  disabled={!v.selected && v.count === 0}
                  onChange={() => onToggle(v.key)}
                />
                {facet.kind === "color" && (
                  <span
                    className="shop-filter-swatch"
                    style={{ background: v.swatch ?? "transparent" }}
                    aria-hidden
                  >
                    {v.selected && <Check size={12} strokeWidth={3} />}
                  </span>
                )}
                <span>{v.label}</span>
                <span className="shop-filter-muted">({v.count})</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          className="shop-filter-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </Group>
  );
}

function PriceGroup({
  query,
  span,
  live,
  onChange,
}: {
  query: ShopQuery;
  span: { min: number; max: number } | null;
  live: boolean;
  onChange: (next: ShopQuery) => void;
}) {
  const text = (n: number | null) => (n === null ? "" : String(n));
  const [min, setMin] = useState(text(query.min));
  const [max, setMax] = useState(text(query.max));

  // ★ Follow a change made OUTSIDE these inputs (a chip removed, "Clear"),
  // but never rewrite what is being typed: the inputs are only replaced when
  // they no longer describe the applied bounds.
  const applied = `${text(query.min)}|${text(query.max)}`;
  const [lastApplied, setLastApplied] = useState(applied);
  if (lastApplied !== applied) {
    setLastApplied(applied);
    if (toBound(min) !== query.min || toBound(max) !== query.max) {
      setMin(text(query.min));
      setMax(text(query.max));
    }
  }

  const commit = (nextMin: string, nextMax: string) => {
    let lo = toBound(nextMin);
    let hi = toBound(nextMax);
    // A backwards range means what it obviously means — swapped once it is
    // applied (the drawer swaps on "Show N"), never mid-typing.
    if (live && lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
    if (lo === query.min && hi === query.max) return;
    onChange({ ...query, min: lo, max: hi, pages: 1 });
  };

  const field = (
    which: "min" | "max",
    value: string,
    set: (v: string) => void,
  ) => (
    <label>
      <span>{which === "min" ? "From" : "To"}</span>
      <span className="shop-filter-money">
        <span aria-hidden>₹</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          aria-label={
            which === "min"
              ? "Minimum price in rupees"
              : "Maximum price in rupees"
          }
          value={value}
          placeholder={
            span ? String(which === "min" ? span.min : span.max) : ""
          }
          onChange={(e) => {
            set(e.target.value);
            if (!live)
              commit(
                which === "min" ? e.target.value : min,
                which === "max" ? e.target.value : max,
              );
          }}
          onBlur={() => live && commit(min, max)}
          onKeyDown={(e) => {
            if (live && e.key === "Enter") commit(min, max);
          }}
        />
      </span>
    </label>
  );

  return (
    <Group
      title="Price"
      selected={query.min !== null || query.max !== null ? 1 : 0}
    >
      {span && (
        <p className="shop-filter-muted shop-filter-hint">
          {formatPrice(span.min)} – {formatPrice(span.max)}
        </p>
      )}
      <div className="shop-filter-range">
        {field("min", min, setMin)}
        {field("max", max, setMax)}
      </div>
    </Group>
  );
}
