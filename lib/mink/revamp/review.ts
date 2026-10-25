// ---------------------------------------------------------------------------
// Mink storefront revamp: the review a ready card shows, built from the stored
// plan with no I/O (docs/mink-storefront-revamp.md section 1, step 3).
//
// ★ PURE AND CLIENT-SAFE, like contract.ts. The status route builds the review
//   on the server, but nothing here may import a server module, so the card
//   could build the same review from a plan it already holds.
//
// ★ DEFENSIVE BY DESIGN. The plan arrives from a jsonb column the status route
//   polls every few seconds; a field an older runner did not write, or a list
//   with one malformed entry, must cost that entry, never the whole card. Every
//   list is read through `list()` and every entry is checked before it is
//   copied, so a review is always a complete, well-typed object.
// ---------------------------------------------------------------------------

import type { StoreChrome } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import type {
  PersonalizationStoredCategory,
  PersonalizationStoredPhoto,
  PersonalizationStoredProduct,
} from "../storefront-personalization-contract";
import {
  revampLiveChanges,
  type RevampCheck,
  type RevampReview,
  type RevampReviewPage,
  type RevampStoredPage,
  type RevampStoredPlan,
  type RevampStoredProductCreate,
} from "./contract";

/** The review for one ready revamp: everything the card shows before Apply. */
export function toRevampReview(plan: RevampStoredPlan): RevampReview {
  const source = record(plan) ?? {};
  const products = record(source.products) ?? {};
  const creates = list(products.create).filter(isProductCreate);
  const hidden = list(products.hide).filter(isHiddenProduct);
  const categories = list(source.categories).filter(isCategoryChange);
  const brand = record(source.brand);
  return {
    summary: text(source.summary),
    pages: list(source.pages).filter(isStoredPage).map(toReviewPage),
    chrome: chromeOf(source.chrome),
    photos: list(source.photos).filter(isPhoto),
    products: creates.map(toReviewProduct),
    categories: categories.map(toReviewCategory),
    hiddenSampleProducts: hidden.length,
    // ★ The same rule the card states BEFORE the Apply button: these parts have
    //   no draft layer, so they change on the shop the moment Apply runs. It is
    //   computed from the lists the review shows, so the warning and the lists
    //   can never disagree about what is in the plan.
    liveChanges: revampLiveChanges({
      categories,
      products: { hide: hidden, create: creates },
      brand: brand
        ? {
            expectedDigest: text(brand.expectedDigest),
            tagline: nullableText(brand.tagline),
            blurb: nullableText(brand.blurb),
          }
        : null,
    }),
    checks: list(source.checks).filter(isCheck),
    skipped: list(source.skipped).filter(isSkipped),
    notes: list(source.notes).filter(
      (note): note is string => typeof note === "string" && note.trim() !== "",
    ),
    // ★ The parts that go live at Apply have no draft to preview, so the
    //   preview canvas is told them as data: without it the "after" frame
    //   shows the old category band and the theme's samples Apply takes off.
    canvas: {
      categories: categories.flatMap(toCanvasCategory),
      hiddenProductIds: hidden.map((product) => product.id),
      ...canvasBrand(brand),
    },
  };
}

/**
 * The tagline and footer description Apply writes, for the "after" frame's
 * footer. ★ Null is a half Apply leaves as it is (apply-v2.ts), so it stays
 * null rather than becoming "", which would read as clearing it.
 */
function canvasBrand(
  brand: Record<string, unknown> | null,
): Pick<NonNullable<RevampReview["canvas"]>, "brand"> {
  const tagline = brand ? nullableText(brand.tagline) : null;
  const blurb = brand ? nullableText(brand.blurb) : null;
  return tagline !== null || blurb !== null
    ? { brand: { tagline, blurb } }
    : {};
}

type CanvasCategory = NonNullable<RevampReview["canvas"]>["categories"][number];

/**
 * One category as the shop shows it after Apply. A new one has no id until
 * Apply makes it, so it gets a stand-in the canvas cannot confuse with a real
 * category; an entry with no usable id or slug is left out, never guessed.
 */
function toCanvasCategory(
  change: PersonalizationStoredCategory,
): CanvasCategory[] {
  const slug = text(change.slug).trim();
  if (!slug) return [];
  if (change.action === "create") {
    return [
      {
        id: `revamp-category-${slug}`.slice(0, 120),
        slug,
        name: change.name,
        imageUrl: nullableText(change.imageUrl),
        description: nullableText(change.description),
        hidden: false,
      },
    ];
  }
  const id = text(change.id).trim();
  if (!id) return [];
  return [
    change.action === "hide"
      ? {
          id,
          slug,
          name: change.name,
          imageUrl: null,
          description: null,
          hidden: true,
        }
      : {
          id,
          slug,
          name: change.name,
          imageUrl: nullableText(change.imageUrl),
          description: nullableText(change.description),
          hidden: false,
        },
  ];
}

// ---------------------------------------------------------------------------
// Pages, chrome and photos.
// ---------------------------------------------------------------------------

function toReviewPage(page: RevampStoredPage): RevampReviewPage {
  const changes = record(page.changes) ?? {};
  return {
    slug: page.slug,
    title: page.title,
    create: page.create === true,
    sections: page.sections,
    changes: {
      added: count(changes.added),
      removed: count(changes.removed),
      kept: count(changes.kept),
      photos: count(changes.photos),
    },
  };
}

function chromeOf(value: unknown): StoreChrome | null {
  const chrome = record(value);
  const next = chrome ? record(chrome.next) : null;
  return next ? (next as unknown as StoreChrome) : null;
}

// ---------------------------------------------------------------------------
// The merchant's products.
// ---------------------------------------------------------------------------

function toReviewProduct(
  product: RevampStoredProductCreate,
): RevampReview["products"][number] {
  const variants = list(product.variants).filter(isVariant);
  // ★ A product sold in sizes is shown at its cheapest size, with the sizes
  //   listed beside it: the card says what the shop will charge, and "from"
  //   wording is the card's decision, not this one's.
  const cheapest = variants.reduce<(typeof variants)[number] | null>(
    (best, variant) => (!best || variant.price < best.price ? variant : best),
    null,
  );
  return {
    key: product.key,
    name: product.name,
    imageUrl:
      nullableText(product.imageUrl) ?? nullableText(product.sourceImageUrl),
    price: cheapest ? cheapest.price : money(product.price),
    mrp: cheapest ? cheapest.mrp : nullableMoney(product.mrp),
    categorySlug: nullableText(product.categorySlug),
    sizes: sizesOf(product, variants),
    sizePrices: sizePricesOf(variants),
  };
}

/**
 * Every size at the price Apply publishes it at. ★ The cheapest alone hides a
 * mistyped dearer size ("1 kg ₹6,990") that goes on the shop at Apply, so the
 * review carries each one; the first entry wins for a repeated name, the
 * same rule `sizesOf` applies to the names.
 */
function sizePricesOf(
  variants: Array<{ name: string; price: number; mrp: number | null }>,
): Array<{ label: string; price: number; mrp: number | null }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; price: number; mrp: number | null }> = [];
  for (const variant of variants) {
    const label = variant.name.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, price: variant.price, mrp: variant.mrp ?? null });
  }
  return out;
}

function sizesOf(
  product: RevampStoredProductCreate,
  variants: Array<{ name: string }>,
): string[] {
  const named = unique(
    variants.map((variant) => variant.name.trim()).filter(Boolean),
  );
  if (named.length) return named;
  // A plan written with options but no variant rows still names its sizes.
  const firstOption = record(list(product.options)[0]);
  return firstOption
    ? unique(
        list(firstOption.values)
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : [];
}

// ---------------------------------------------------------------------------
// Categories, in the merchant's words.
// ---------------------------------------------------------------------------

function toReviewCategory(
  change: PersonalizationStoredCategory,
): RevampReview["categories"][number] {
  if (change.action === "create") {
    return {
      action: "New category",
      name: change.name,
      imageUrl: nullableText(change.imageUrl),
    };
  }
  if (change.action === "hide") {
    return {
      action: "Hidden from your shop",
      name: change.name,
      imageUrl: null,
    };
  }
  const before = record(change.before) ?? {};
  const previousName = text(before.name).trim();
  const renamed = previousName !== "" && previousName !== change.name.trim();
  const newPhoto =
    nullableText(change.imageUrl) !== nullableText(before.imageUrl);
  const newDescription =
    nullableText(change.description) !== nullableText(before.description);
  return {
    action: renamed
      ? `Renamed from ${previousName}`
      : newPhoto && newDescription
        ? "New photo and description"
        : newPhoto
          ? "New photo"
          : newDescription
            ? "New description"
            : "Updated",
    name: change.name,
    imageUrl: nullableText(change.imageUrl),
  };
}

// ---------------------------------------------------------------------------
// Guards: an entry that fails one is left out, never half copied.
// ---------------------------------------------------------------------------

function isStoredPage(value: unknown): value is RevampStoredPage {
  const page = record(value);
  return (
    !!page &&
    typeof page.slug === "string" &&
    typeof page.title === "string" &&
    Array.isArray(page.sections) &&
    page.sections.every(isSection)
  );
}

function isSection(value: unknown): value is PageSectionItem {
  const section = record(value);
  return (
    !!section &&
    typeof section.id === "string" &&
    typeof section.type === "string"
  );
}

function isPhoto(value: unknown): value is PersonalizationStoredPhoto {
  const photo = record(value);
  return (
    !!photo &&
    typeof photo.url === "string" &&
    typeof photo.path === "string" &&
    typeof photo.alt === "string" &&
    typeof photo.where === "string"
  );
}

function isProductCreate(value: unknown): value is RevampStoredProductCreate {
  const product = record(value);
  return (
    !!product &&
    typeof product.key === "string" &&
    typeof product.name === "string"
  );
}

function isVariant(
  value: unknown,
): value is { name: string; price: number; mrp: number | null } {
  const variant = record(value);
  return (
    !!variant &&
    typeof variant.name === "string" &&
    isMoney(variant.price) &&
    (variant.mrp === null || variant.mrp === undefined || isMoney(variant.mrp))
  );
}

function isHiddenProduct(
  value: unknown,
): value is PersonalizationStoredProduct {
  const product = record(value);
  return !!product && typeof product.id === "string";
}

function isCategoryChange(
  value: unknown,
): value is PersonalizationStoredCategory {
  const change = record(value);
  if (!change || typeof change.name !== "string") return false;
  return (
    change.action === "create" ||
    change.action === "update" ||
    change.action === "hide"
  );
}

function isCheck(value: unknown): value is RevampCheck {
  const check = record(value);
  return (
    !!check &&
    typeof check.id === "string" &&
    typeof check.label === "string" &&
    typeof check.passed === "boolean" &&
    (check.note === null || typeof check.note === "string")
  );
}

function isSkipped(value: unknown): value is { label: string; reason: string } {
  const entry = record(value);
  return (
    !!entry &&
    typeof entry.label === "string" &&
    typeof entry.reason === "string"
  );
}

// ---------------------------------------------------------------------------
// Small readers.
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function money(value: unknown): number {
  return isMoney(value) ? value : 0;
}

function nullableMoney(value: unknown): number | null {
  return isMoney(value) ? value : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
