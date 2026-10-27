"use client";

import { useEffect, useMemo, useState } from "react";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  mapSectionData,
  type SectionDatasets,
  type SectionProduct,
} from "@/lib/sections/map-data";
import type { CategoryTile } from "@/app/(storefront)/components/homepage/shop-by-category-section";
import { PageSectionRenderer } from "./page-section-renderer";

// Builder preview canvas: renders the draft sections CLIENT-side so edits in
// the builder paint instantly. The parent builder posts the latest draft via
// `sm-draft` on every mutation (autosave still runs in the background); the
// RSC render remains the source of truth for the initial load and publish.
// Data-driven sections re-resolve locally from the dataset snapshots the
// server passed down, using the same pure mapper as the real page — the
// preview can never drift from published rendering logic.
//
// ★ AN `sm-draft` MAY ALSO CARRY `datasets`: products and categories that do
//   not exist yet (Mink's storefront revamp preview shows the merchant's new
//   products before they are created). They are merged OVER the server's
//   snapshot, never trusted as given: every entry is rebuilt from a fixed set
//   of fields, counts are bounded, and only the frame that embeds this canvas
//   may send them.
//
// ★★ AND WHAT A REVAMP TAKES AWAY. Apply hides the theme's sample products
//   and may rename or hide a category, live and at once, so the preview of
//   the result must not show them as they are now: `hiddenProductIds` and
//   `hiddenCategoryIds` drop entries from the snapshot, and a category that
//   arrives with an id the snapshot already holds REPLACES it where it
//   stands (the shop keeps its order), rather than appearing beside it.

/** Bounds on what one message may add, so a bad message cannot balloon. */
export const MAX_DRAFT_PRODUCTS = 200;
export const MAX_DRAFT_CATEGORIES = 100;

export interface DraftDatasets {
  products?: SectionProduct[];
  categories?: CategoryTile[];
  /** Products the previewed change takes off the shop. */
  hiddenProductIds?: string[];
  /** Categories the previewed change hides. */
  hiddenCategoryIds?: string[];
}

const MAX_PRICE = 1_000_000_000;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function nullableText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length <= max ? value : undefined;
}

/** A site path or an https URL; never `//host`, `javascript:` or `data:`. */
function imageUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return /^https:\/\/[^\s"'<>]+$/i.test(value) ? value : undefined;
}

function amount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PRICE
    ? value
    : null;
}

function readProduct(value: unknown): SectionProduct | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 120);
  const name = text(row.name, 300);
  const slug = text(row.slug, 300);
  const image = imageUrl(row.image_url);
  const base = amount(row.base_price);
  const selling = amount(row.selling_price);
  const category = nullableText(row.category, 200);
  const categoryId = nullableText(row.category_id, 120);
  const stock = amount(row.stock);
  const threshold =
    row.low_stock_threshold === null || row.low_stock_threshold === undefined
      ? null
      : amount(row.low_stock_threshold);
  if (
    !id ||
    !name ||
    !slug ||
    image === undefined ||
    base === null ||
    selling === null ||
    category === undefined ||
    categoryId === undefined ||
    (row.low_stock_threshold !== null &&
      row.low_stock_threshold !== undefined &&
      threshold === null)
  ) {
    return null;
  }
  // Rebuilt field by field: nothing outside this list reaches the cards.
  return {
    id,
    name,
    slug,
    image_url: image,
    base_price: base,
    selling_price: selling,
    featured: row.featured === true,
    category,
    category_id: categoryId,
    track_inventory: row.track_inventory === true,
    stock: stock === null ? 0 : Math.floor(stock),
    low_stock_threshold: threshold,
    allow_backorder: row.allow_backorder === true,
  };
}

function readCategory(value: unknown): CategoryTile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 120);
  const name = text(row.name, 300);
  const slug = text(row.slug, 300);
  const image = imageUrl(row.image_url);
  const description = nullableText(row.description, 1000);
  if (!id || !name || !slug || image === undefined || description === undefined)
    return null;
  return { id, name, slug, image_url: image, description };
}

function readList<T>(
  value: unknown,
  max: number,
  read: (entry: unknown) => T | null,
): T[] | undefined {
  // Not a list, or longer than allowed: ignored whole rather than cut short.
  if (!Array.isArray(value) || value.length > max) return undefined;
  return value.map(read).filter((entry): entry is T => entry !== null);
}

function readId(value: unknown): string | null {
  return text(value, 120);
}

/**
 * The `datasets` of an `sm-draft` message, validated. Null when it carries
 * nothing usable, so a malformed message changes nothing.
 */
export function readDraftDatasets(value: unknown): DraftDatasets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const products = readList(row.products, MAX_DRAFT_PRODUCTS, readProduct);
  const categories = readList(
    row.categories,
    MAX_DRAFT_CATEGORIES,
    readCategory,
  );
  const hiddenProductIds = readList(
    row.hiddenProductIds,
    MAX_DRAFT_PRODUCTS,
    readId,
  );
  const hiddenCategoryIds = readList(
    row.hiddenCategoryIds,
    MAX_DRAFT_CATEGORIES,
    readId,
  );
  const out: DraftDatasets = {};
  if (products) out.products = products;
  if (categories) out.categories = categories;
  if (hiddenProductIds?.length) out.hiddenProductIds = hiddenProductIds;
  if (hiddenCategoryIds?.length) out.hiddenCategoryIds = hiddenCategoryIds;
  return out.products ||
    out.categories ||
    out.hiddenProductIds ||
    out.hiddenCategoryIds
    ? out
    : null;
}

function mergeById<T extends { id: string }>(
  base: T[],
  extra?: T[],
  hidden: ReadonlySet<string> = new Set<string>(),
): T[] {
  const kept = hidden.size
    ? base.filter((entry) => !hidden.has(entry.id))
    : base;
  if (!extra?.length) return kept;
  const ids = new Set(extra.map((entry) => entry.id));
  // The message's entries come first, so a limited section shows them.
  return [...extra, ...kept.filter((entry) => !ids.has(entry.id))];
}

/**
 * Categories as a change leaves them: one the snapshot holds is replaced
 * where it stands, a hidden one is dropped, and a new one joins at the end.
 */
function patchById<T extends { id: string }>(
  base: T[],
  extra: T[] | undefined,
  hidden: ReadonlySet<string>,
): T[] {
  if (!extra?.length && !hidden.size) return base;
  const replacements = new Map((extra ?? []).map((entry) => [entry.id, entry]));
  const known = new Set(base.map((entry) => entry.id));
  return [
    ...base
      .filter((entry) => !hidden.has(entry.id))
      .map((entry) => replacements.get(entry.id) ?? entry),
    ...(extra ?? []).filter(
      (entry) => !known.has(entry.id) && !hidden.has(entry.id),
    ),
  ];
}

/** The server's snapshot with a message's entries merged over it. */
export function mergeDatasets(
  base: SectionDatasets,
  extra: DraftDatasets | null,
): SectionDatasets {
  if (!extra) return base;
  return {
    products: mergeById(
      base.products,
      extra.products,
      new Set(extra.hiddenProductIds ?? []),
    ),
    categories: patchById(
      base.categories,
      extra.categories,
      new Set(extra.hiddenCategoryIds ?? []),
    ),
    blogs: base.blogs,
  };
}

export function DraftCanvas({
  initialSections,
  datasets,
}: {
  initialSections: PageSectionItem[];
  datasets: SectionDatasets;
}) {
  const [sections, setSections] = useState(initialSections);
  const [extra, setExtra] = useState<DraftDatasets | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Same-origin only (dashboard + storefront share the host).
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: string;
        sections?: unknown;
        datasets?: unknown;
      };
      if (data?.type === "sm-draft" && Array.isArray(data.sections)) {
        setSections(data.sections as PageSectionItem[]);
        // ★ Only the frame that embeds this preview may add data to it.
        if ("datasets" in data && event.source === window.parent) {
          setExtra(readDraftDatasets(data.datasets));
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const merged = useMemo(
    () => mergeDatasets(datasets, extra),
    [datasets, extra],
  );
  const resolved = useMemo(
    () => mapSectionData(sections, merged),
    [sections, merged],
  );

  return <PageSectionRenderer sections={sections} resolved={resolved} />;
}
