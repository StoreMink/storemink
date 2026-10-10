// ---------------------------------------------------------------------------
// Page templates (plan Phase 2e): what the product and collection pages are
// COMPOSED of, beyond the layout variant each page already has.
//
// ★ A TEMPLATE IS DATA THE RENDERER WALKS, like a page's section list. The
//   product page used to be two hand-written compositions (classic/editorial
//   markup, grocery markup); its information column is now an ordered list
//   of BLOCKS and its gallery one of five shapes, and the collection page
//   chooses where its filters live, how it pages and whether promo tiles sit
//   in the grid. The layout variant itself stays where it was
//   (`design.layout.productDetail`, with `stacked` joining classic, editorial
//   and grocery) so an installed theme's pin and a merchant's existing
//   override keep meaning what they meant.
// ★ ABSENT MEANS TODAY. `defaultTemplates(layout)` is exactly the composition
//   every store renders now, derived from the layout it already has (the
//   phone sticky bar is a block, present when `layout.stickyAddToCart` was),
//   so a theme without a `templates` field and a store with no override are
//   byte-for-byte unchanged. That is the "v2 → v3 migration" the plan asks
//   for, done as a pure function rather than a schema bump: an optional field
//   keeps every stored release readable, the precedent `people` set.
// ★ PURE AND CLIENT-SAFE: the builder edits these, the storefront renders
//   them, the Studio contract validates them, Mink reads them.
// ★ THE COMMERCE BLOCKS ARE NOT OPTIONAL. A product page without a price or a
//   buy box cannot sell, so normalising appends them and the contract names
//   their absence; everything else is the theme's call.
// ---------------------------------------------------------------------------

import type { ThemeLayout } from "./types";
import { USP_ICONS, type UspIcon } from "@/lib/homepage/section-types";
import { SECTION_SCHEMES, type SectionScheme } from "./schemes";
import { sameJson } from "./canonical-json";

export const PRODUCT_GALLERIES = [
  "thumbs-bottom",
  "thumbs-left",
  "stacked",
  "carousel",
  "grid",
] as const;
export type ProductGalleryMode = (typeof PRODUCT_GALLERIES)[number];

export const PRODUCT_BLOCK_TYPES = [
  "price",
  "variant_picker",
  "buy_box",
  "description",
  "delivery_estimate",
  "share",
  "trust_row",
  "accordion",
  "size_guide",
  "rich_text",
  "reviews",
  "recommendations",
  "sticky_bar",
] as const;
export type ProductBlockType = (typeof PRODUCT_BLOCK_TYPES)[number];

/** Blocks the product page cannot sell without. */
export const REQUIRED_PRODUCT_BLOCKS = ["price", "buy_box"] as const;
/** Blocks that render in the information column beside the gallery, in
 *  order; the rest render under the whole grid (reviews, recommendations)
 *  or are a switch (sticky_bar). */
export const PRODUCT_INFO_BLOCKS: readonly ProductBlockType[] = [
  "price",
  "variant_picker",
  "buy_box",
  "description",
  "delivery_estimate",
  "share",
  "trust_row",
  "accordion",
  "size_guide",
  "rich_text",
];
export const PRODUCT_PAGE_BLOCKS: readonly ProductBlockType[] = [
  "reviews",
  "recommendations",
];

export const MAX_TRUST_ROW_ITEMS = 6;
export const MAX_ACCORDION_ROWS = 8;
export const MAX_SIZE_GUIDE_COLUMNS = 8;
export const MAX_SIZE_GUIDE_ROWS = 12;
export const ACCORDION_BODY_MAX = 2000;
export const RICH_TEXT_MAX = 4000;
export const MAX_PROMO_TILES = 4;
/** A tile may sit after the 1st to the 48th card (two load-more pages). */
export const MAX_PROMO_AFTER = 48;

export interface TrustRowItem {
  icon: UspIcon;
  label: string;
}
export interface AccordionRow {
  heading: string;
  body: string;
}
/** One size's measurements, in the guide's column order. */
export interface SizeGuideRow {
  label: string;
  values: string[];
}
export type ProductBlock =
  | {
      type:
        | "price"
        | "variant_picker"
        | "buy_box"
        | "description"
        | "delivery_estimate"
        | "share"
        | "reviews"
        | "recommendations"
        | "sticky_bar";
    }
  | { type: "trust_row"; items: TrustRowItem[] }
  | { type: "accordion"; rows: AccordionRow[] }
  | { type: "size_guide"; columns: string[]; sizes: SizeGuideRow[] }
  | { type: "rich_text"; html: string };

export interface ProductTemplate {
  gallery: ProductGalleryMode;
  blocks: ProductBlock[];
}

export const COLLECTION_FILTERS = ["sidebar", "drawer", "top-bar"] as const;
export type CollectionFilters = (typeof COLLECTION_FILTERS)[number];
export const COLLECTION_PAGINATIONS = [
  "load-more",
  "paged",
  "infinite",
] as const;
export type CollectionPagination = (typeof COLLECTION_PAGINATIONS)[number];

/** A tile the theme places in the product grid after the Nth card: an
 *  offer, a collection link, a line of brand copy. Rendered card-sized. */
export interface PromoTile {
  afterIndex: number;
  heading: string;
  body: string;
  cta_label: string;
  href: string;
  image_url: string;
  image_alt: string;
  theme: "dark" | "light";
  /** A strict hex colour, or "" for the page's deep field. */
  background: string;
}

export interface CollectionTemplate {
  filters: CollectionFilters;
  pagination: CollectionPagination;
  promoTiles: PromoTile[];
}

/** The blog index as a grid of cards, a list of rows (picture beside the
 *  copy), or a featured first post above the grid; the article narrow (a
 *  reading column), wide, or with an aside of related posts. */
export const BLOG_INDEX_LAYOUTS = ["grid", "list", "featured"] as const;
export type BlogIndexLayout = (typeof BLOG_INDEX_LAYOUTS)[number];
export const BLOG_ARTICLE_LAYOUTS = ["narrow", "wide", "sidebar"] as const;
export type BlogArticleLayout = (typeof BLOG_ARTICLE_LAYOUTS)[number];
export interface BlogTemplate {
  index: BlogIndexLayout;
  article: BlogArticleLayout;
}

/** The account pages (profile, orders, notifications): as they are, with a
 *  row of tabs above each page, or with a navigation column beside it; and
 *  an optional colour scheme over the three pages. */
export const ACCOUNT_LAYOUTS = ["plain", "tabs", "sidebar"] as const;
export type AccountLayout = (typeof ACCOUNT_LAYOUTS)[number];
/** "" is the page's own colours. */
export const ACCOUNT_SCHEMES = ["", ...SECTION_SCHEMES] as const;
export type AccountScheme = "" | SectionScheme;
export interface AccountTemplate {
  layout: AccountLayout;
  scheme: AccountScheme;
}

export interface ThemeTemplates {
  product: ProductTemplate;
  collection: CollectionTemplate;
  blog: BlogTemplate;
  account: AccountTemplate;
}

// ── defaults ────────────────────────────────────────────────────────────────

/** Today's product page, block by block, in the order it has rendered
 *  since the share buttons moved under the price. */
export function defaultProductBlocks(
  layout?: ThemeLayout | null,
): ProductBlock[] {
  return [
    { type: "price" },
    { type: "share" },
    { type: "variant_picker" },
    { type: "delivery_estimate" },
    { type: "buy_box" },
    { type: "description" },
    { type: "reviews" },
    { type: "recommendations" },
    ...(layout?.stickyAddToCart === true
      ? [{ type: "sticky_bar" } as const]
      : []),
  ];
}

export function defaultTemplates(layout?: ThemeLayout | null): ThemeTemplates {
  return {
    product: { gallery: "thumbs-bottom", blocks: defaultProductBlocks(layout) },
    collection: { filters: "sidebar", pagination: "load-more", promoTiles: [] },
    blog: { index: "grid", article: "narrow" },
    account: { layout: "plain", scheme: "" },
  };
}

// ── normalising (coerce, never throw) ───────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const oneOf = <T extends string>(
  v: unknown,
  values: readonly T[],
  fallback: T,
): T => (values.includes(v as T) ? (v as T) : fallback);
/** A site path, an https/http URL, or "". Never a script or data URL. */
export function templateHref(v: unknown): string {
  const s = text(v, 2048);
  if (!s) return "";
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return "";
}
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const hexOrEmpty = (v: unknown): string =>
  HEX.test(text(v, 8)) ? text(v, 8) : "";

function normalizeBlock(raw: unknown): ProductBlock | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (!PRODUCT_BLOCK_TYPES.includes(type as ProductBlockType)) return null;
  switch (type as ProductBlockType) {
    case "trust_row": {
      const items = (Array.isArray(raw.items) ? raw.items : [])
        .map((item): TrustRowItem | null => {
          if (!isRecord(item)) return null;
          const label = text(item.label, 60);
          if (!label) return null;
          return { icon: oneOf(item.icon, USP_ICONS, USP_ICONS[0]), label };
        })
        .filter((item): item is TrustRowItem => item !== null)
        .slice(0, MAX_TRUST_ROW_ITEMS);
      return items.length ? { type: "trust_row", items } : null;
    }
    case "accordion": {
      const rows = (Array.isArray(raw.rows) ? raw.rows : [])
        .map((row): AccordionRow | null => {
          if (!isRecord(row)) return null;
          const heading = text(row.heading, 120);
          const body = text(row.body, ACCORDION_BODY_MAX);
          if (!heading || !body) return null;
          return { heading, body };
        })
        .filter((row): row is AccordionRow => row !== null)
        .slice(0, MAX_ACCORDION_ROWS);
      return rows.length ? { type: "accordion", rows } : null;
    }
    case "size_guide": {
      const columns = (Array.isArray(raw.columns) ? raw.columns : [])
        .map((column) => text(column, 40))
        .filter(Boolean)
        .slice(0, MAX_SIZE_GUIDE_COLUMNS);
      const sizes = (Array.isArray(raw.sizes) ? raw.sizes : [])
        .map((row): SizeGuideRow | null => {
          if (!isRecord(row)) return null;
          const label = text(row.label, 40);
          if (!label) return null;
          // One cell per column, in column order; missing cells are "".
          const values = columns.map((_, i) =>
            Array.isArray(row.values) ? text(row.values[i], 40) : "",
          );
          return { label, values };
        })
        .filter((row): row is SizeGuideRow => row !== null)
        .slice(0, MAX_SIZE_GUIDE_ROWS);
      return columns.length && sizes.length
        ? { type: "size_guide", columns, sizes }
        : null;
    }
    case "rich_text": {
      const html = text(raw.html, RICH_TEXT_MAX);
      return html ? { type: "rich_text", html } : null;
    }
    default:
      return {
        type: type as Exclude<
          ProductBlockType,
          "trust_row" | "accordion" | "size_guide" | "rich_text"
        >,
      };
  }
}

/** Blocks in the given order, each type at most once (the first wins),
 *  unknown and empty ones dropped, and the commerce blocks present. */
export function normalizeProductBlocks(
  raw: unknown,
  fallback: readonly ProductBlock[],
): ProductBlock[] {
  if (!Array.isArray(raw)) return fallback.map((b) => ({ ...b }));
  const seen = new Set<ProductBlockType>();
  const blocks: ProductBlock[] = [];
  for (const entry of raw) {
    const block = normalizeBlock(entry);
    if (!block || seen.has(block.type)) continue;
    seen.add(block.type);
    blocks.push(block);
  }
  for (const type of REQUIRED_PRODUCT_BLOCKS)
    if (!seen.has(type)) blocks.push({ type });
  return blocks;
}

export function normalizeProductTemplate(
  raw: unknown,
  fallback: ProductTemplate,
): ProductTemplate {
  const r = isRecord(raw) ? raw : {};
  return {
    gallery: oneOf(r.gallery, PRODUCT_GALLERIES, fallback.gallery),
    blocks: normalizeProductBlocks(r.blocks, fallback.blocks),
  };
}

function normalizePromoTile(raw: unknown): PromoTile | null {
  if (!isRecord(raw)) return null;
  const afterIndex = Number(raw.afterIndex);
  const heading = text(raw.heading, 80);
  const image_url = templateHref(raw.image_url);
  // A tile with neither a heading nor a picture is an empty card.
  if (!heading && !image_url) return null;
  return {
    afterIndex: Number.isInteger(afterIndex)
      ? Math.min(MAX_PROMO_AFTER, Math.max(1, afterIndex))
      : 1,
    heading,
    body: text(raw.body, 200),
    cta_label: text(raw.cta_label, 40),
    href: templateHref(raw.href),
    image_url,
    image_alt: text(raw.image_alt, 160),
    theme: oneOf(raw.theme, ["dark", "light"] as const, "dark"),
    background: hexOrEmpty(raw.background),
  };
}

export function normalizeCollectionTemplate(
  raw: unknown,
  fallback: CollectionTemplate,
): CollectionTemplate {
  const r = isRecord(raw) ? raw : {};
  const promoTiles = (Array.isArray(r.promoTiles) ? r.promoTiles : [])
    .map(normalizePromoTile)
    .filter((tile): tile is PromoTile => tile !== null)
    .slice(0, MAX_PROMO_TILES);
  return {
    filters: oneOf(r.filters, COLLECTION_FILTERS, fallback.filters),
    pagination: oneOf(
      r.pagination,
      COLLECTION_PAGINATIONS,
      fallback.pagination,
    ),
    promoTiles: Array.isArray(r.promoTiles)
      ? promoTiles
      : fallback.promoTiles.map((t) => ({ ...t })),
  };
}

export function normalizeBlogTemplate(
  raw: unknown,
  fallback: BlogTemplate,
): BlogTemplate {
  const r = isRecord(raw) ? raw : {};
  return {
    index: oneOf(r.index, BLOG_INDEX_LAYOUTS, fallback.index),
    article: oneOf(r.article, BLOG_ARTICLE_LAYOUTS, fallback.article),
  };
}

export function normalizeAccountTemplate(
  raw: unknown,
  fallback: AccountTemplate,
): AccountTemplate {
  const r = isRecord(raw) ? raw : {};
  return {
    layout: oneOf(r.layout, ACCOUNT_LAYOUTS, fallback.layout),
    // null from a closed schema reads as the page's own colours.
    scheme:
      r.scheme === null || r.scheme === undefined
        ? fallback.scheme
        : oneOf(r.scheme, ACCOUNT_SCHEMES, fallback.scheme),
  };
}

/** A complete templates value: the stored one coerced, or the fallback. */
export function normalizeTemplates(
  raw: unknown,
  fallback: ThemeTemplates,
): ThemeTemplates {
  const r = isRecord(raw) ? raw : {};
  return {
    product: normalizeProductTemplate(r.product, fallback.product),
    collection: normalizeCollectionTemplate(r.collection, fallback.collection),
    blog: normalizeBlogTemplate(r.blog, fallback.blog),
    account: normalizeAccountTemplate(r.account, fallback.account),
  };
}

/** The templates a theme preset renders: its own, completed against the
 *  composition its layout already implies. */
export function themeTemplates(preset: {
  design: { layout?: ThemeLayout };
  templates?: unknown;
}): ThemeTemplates {
  return normalizeTemplates(
    preset.templates,
    defaultTemplates(preset.design.layout),
  );
}

// ── reading ─────────────────────────────────────────────────────────────────

export function hasProductBlock(
  template: ProductTemplate,
  type: ProductBlockType,
): boolean {
  return template.blocks.some((block) => block.type === type);
}

/** The product page's blocks by where they render. */
export function splitProductBlocks(blocks: readonly ProductBlock[]): {
  info: ProductBlock[];
  page: ProductBlock[];
  sticky: boolean;
} {
  return {
    info: blocks.filter((b) => PRODUCT_INFO_BLOCKS.includes(b.type)),
    page: blocks.filter((b) => PRODUCT_PAGE_BLOCKS.includes(b.type)),
    sticky: blocks.some((b) => b.type === "sticky_bar"),
  };
}

// ── strict reporting (the package contract) ─────────────────────────────────

/** Why a stored templates value is not one the renderer would show as
 *  written. Empty when it is. Pairs with `normalizeTemplates`: anything that
 *  would be coerced or dropped is named here instead, so a Studio draft is
 *  repaired rather than silently trimmed. */
export function templateIssues(
  raw: unknown,
  path = "definition.preset.templates",
): string[] {
  const issues: string[] = [];
  if (!isRecord(raw)) return [`${path} must be an object.`];
  for (const key of Object.keys(raw))
    if (!["product", "collection", "blog", "account"].includes(key))
      issues.push(`${path}.${key} is not a template.`);
  const product = raw.product;
  if (product !== undefined) {
    if (!isRecord(product)) issues.push(`${path}.product must be an object.`);
    else {
      for (const key of Object.keys(product))
        if (!["gallery", "blocks"].includes(key))
          issues.push(
            `${path}.product.${key} is not a product template field.`,
          );
      if (!PRODUCT_GALLERIES.includes(product.gallery as ProductGalleryMode))
        issues.push(
          `${path}.product.gallery must be one of ${PRODUCT_GALLERIES.join(", ")}.`,
        );
      if (!Array.isArray(product.blocks))
        issues.push(`${path}.product.blocks must be an array.`);
      else {
        const seen = new Set<string>();
        product.blocks.forEach((block, index) => {
          const where = `${path}.product.blocks[${index}]`;
          const normalized = normalizeBlock(block);
          const type = isRecord(block) ? String(block.type) : "";
          if (!normalized) {
            issues.push(
              PRODUCT_BLOCK_TYPES.includes(type as ProductBlockType)
                ? `${where} (${type}) is empty: give it its items, rows, columns and sizes, or html.`
                : `${where} must be one of ${PRODUCT_BLOCK_TYPES.join(", ")}.`,
            );
            return;
          }
          if (seen.has(normalized.type))
            issues.push(
              `${where} repeats ${normalized.type}; each block appears once.`,
            );
          seen.add(normalized.type);
          // Structural, never JSON.stringify: a stored package comes back
          // from jsonb with its keys reordered, and a block that normalises
          // to itself must read as itself whatever order it arrived in.
          if (!sameJson(normalized, block))
            issues.push(
              `${where} (${normalized.type}) has extra, over-long or invalid fields.`,
            );
        });
        for (const type of REQUIRED_PRODUCT_BLOCKS)
          if (!seen.has(type))
            issues.push(`${path}.product.blocks must include ${type}.`);
      }
    }
  }
  const collection = raw.collection;
  if (collection !== undefined) {
    if (!isRecord(collection))
      issues.push(`${path}.collection must be an object.`);
    else {
      for (const key of Object.keys(collection))
        if (!["filters", "pagination", "promoTiles"].includes(key))
          issues.push(
            `${path}.collection.${key} is not a collection template field.`,
          );
      if (!COLLECTION_FILTERS.includes(collection.filters as CollectionFilters))
        issues.push(
          `${path}.collection.filters must be one of ${COLLECTION_FILTERS.join(", ")}.`,
        );
      if (
        !COLLECTION_PAGINATIONS.includes(
          collection.pagination as CollectionPagination,
        )
      )
        issues.push(
          `${path}.collection.pagination must be one of ${COLLECTION_PAGINATIONS.join(", ")}.`,
        );
      if (!Array.isArray(collection.promoTiles))
        issues.push(`${path}.collection.promoTiles must be an array.`);
      else {
        if (collection.promoTiles.length > MAX_PROMO_TILES)
          issues.push(
            `${path}.collection.promoTiles holds at most ${MAX_PROMO_TILES} tiles.`,
          );
        collection.promoTiles.forEach((tile, index) => {
          const where = `${path}.collection.promoTiles[${index}]`;
          const normalized = normalizePromoTile(tile);
          if (!normalized) issues.push(`${where} needs a heading or an image.`);
          else if (!sameJson(normalized, tile))
            issues.push(
              `${where} has extra, over-long or invalid fields (afterIndex 1–${MAX_PROMO_AFTER}, a site path or https link, a hex background).`,
            );
        });
      }
    }
  }
  const blog = raw.blog;
  if (blog !== undefined) {
    if (!isRecord(blog)) issues.push(`${path}.blog must be an object.`);
    else {
      for (const key of Object.keys(blog))
        if (!["index", "article"].includes(key))
          issues.push(`${path}.blog.${key} is not a blog template field.`);
      if (!BLOG_INDEX_LAYOUTS.includes(blog.index as BlogIndexLayout))
        issues.push(
          `${path}.blog.index must be one of ${BLOG_INDEX_LAYOUTS.join(", ")}.`,
        );
      if (!BLOG_ARTICLE_LAYOUTS.includes(blog.article as BlogArticleLayout))
        issues.push(
          `${path}.blog.article must be one of ${BLOG_ARTICLE_LAYOUTS.join(", ")}.`,
        );
    }
  }
  const account = raw.account;
  if (account !== undefined) {
    if (!isRecord(account)) issues.push(`${path}.account must be an object.`);
    else {
      for (const key of Object.keys(account))
        if (!["layout", "scheme"].includes(key))
          issues.push(
            `${path}.account.${key} is not an account template field.`,
          );
      if (!ACCOUNT_LAYOUTS.includes(account.layout as AccountLayout))
        issues.push(
          `${path}.account.layout must be one of ${ACCOUNT_LAYOUTS.join(", ")}.`,
        );
      if (!ACCOUNT_SCHEMES.includes(account.scheme as AccountScheme))
        issues.push(
          `${path}.account.scheme must be "" or one of ${SECTION_SCHEMES.join(", ")}.`,
        );
    }
  }
  return issues;
}
