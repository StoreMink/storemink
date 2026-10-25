// Shapes shared by the Media Library page, the product editor's library
// picker and their server reads. Client-safe: types and pure helpers only, so
// a client component never imports the server module that fills them.

/** A Media Library row as the page, the picker and the actions return it. */
export interface MediaAsset {
  id: string;
  url: string;
  path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Where the row came from (lib/media/sources.ts). */
  source: string;
  created_at: string;
}

/** A product that uses an image, for "Used by" labels and links. */
export interface ProductRef {
  id: string;
  name: string;
}

/** One photo a product uses, with every product that uses it. */
export interface ProductImageItem {
  url: string;
  products: ProductRef[];
}

/** One tile in the product editor's "Choose from library" picker. */
export interface MediaPickerItem {
  url: string;
  /** A Library upload's file name; empty for a product photo. */
  filename: string;
  /** "Made by Mink AI" and the like; null for an ordinary upload. */
  label: string | null;
  /** Products that already use this image. */
  products: ProductRef[];
}

export type MediaPickerTab = "library" | "products";

export interface MediaPickerPage {
  items: MediaPickerItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** How many photos the picker and the Product images tab show per page. */
export const MEDIA_PICKER_PAGE_SIZE = 24;

/** "Almond shake", "Almond shake and Cold coffee", "Almond shake and 2 more". */
export function usedByLabel(products: readonly ProductRef[]): string {
  const names = [...products]
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

/**
 * What in a store, besides its products, still shows a Library image: the
 * delete guard's answer (lib/media/image-usage.ts fills it).
 */
export interface StorefrontImageUsage {
  /** A storefront redesign Mink AI is still making, or refining, holds it. */
  redesignInProgress: boolean;
  /** A storefront redesign card nobody has applied yet shows it. */
  redesignCard: boolean;
  /** Pages whose Builder draft or live version shows it, by name. */
  pages: string[];
  /** Categories whose photo it is, by name. */
  categories: string[];
  /** The header or footer, draft or live. */
  headerFooter: boolean;
}

/** "The Home page", "The Home and About pages", "The Home page and 2 more pages". */
function placesLabel(names: readonly string[], noun: string, plural: string) {
  if (names.length === 1) return `The ${names[0]} ${noun} uses`;
  if (names.length === 2) {
    return `The ${names[0]} and ${names[1]} ${plural} use`;
  }
  return `The ${names[0]} ${noun} and ${names.length - 1} more ${plural} use`;
}

/**
 * Why a Library image cannot be deleted, or null when nothing here uses it.
 *
 * ★ ONE ANSWER, THE ONE TO ACT ON FIRST: a redesign still being made, then a
 *   card nobody applied (its preview and its Apply need the photo), then the
 *   pages, categories and header or footer that show it. Each names the place,
 *   because "this image is in use" alone leaves the merchant searching.
 */
export function imageInUseMessage(usage: StorefrontImageUsage): string | null {
  if (usage.redesignInProgress) {
    return "Mink AI is still making a storefront redesign that uses this image. Wait for its review card, then apply it or ask Mink AI to change the photo.";
  }
  if (usage.redesignCard) {
    return "A storefront redesign from Mink AI uses this image and has not been applied yet. Apply it to your Website Builder draft, or ask Mink AI to change the photo, first.";
  }
  if (usage.pages.length > 0) {
    const one = usage.pages.length === 1;
    return `${placesLabel(usage.pages, "page", "pages")} this image. Change the photo on ${one ? "that page" : "those pages"} in the Website Builder first.`;
  }
  if (usage.categories.length > 0) {
    const one = usage.categories.length === 1;
    return `${placesLabel(usage.categories, "category", "categories")} this image. Change ${one ? "that category's photo" : "their photos"} first.`;
  }
  if (usage.headerFooter) {
    return "Your header or footer uses this image. Change it in the Website Builder first.";
  }
  return null;
}
