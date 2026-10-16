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
