// Where a Media Library row came from (`media_assets.source`), and which of
// those the Library lists. Client-safe: no server imports.
//
// ★★ A ROW IS KEPT FOR EVERY ONE OF THESE, EVEN THE HIDDEN ONES. Mink's
//    ownership checks (`selectOwnedStorefrontImageUrls`, the image reference
//    resolver, `propose_product_create`) accept an image because a
//    `media_assets` row says this store owns it, so a chat attachment that
//    stopped writing its row could no longer become a product photo or a
//    banner. Hiding is a question about the Library screen, never about
//    ownership.

export const MEDIA_SOURCES = [
  /** Uploaded on the Media Library page. */
  "upload",
  /** Attached to a Mink AI chat message. */
  "mink_attachment",
  /** A picture Mink AI created. */
  "mink_generated",
  /** A product photo refined with Mink AI. */
  "mink_refined",
  /** A copy Mink AI resized for a product card or blog cover. */
  "mink_prepared",
  /** A product photo with its background removed or replaced. */
  "mink_edited",
] as const;

export type MediaSource = (typeof MEDIA_SOURCES)[number];

/**
 * Rows the Library does not list.
 *
 * ★ A chat attachment is something the merchant handed to Mink, not something
 *   they chose to keep, so listing it filled the Library with every photo ever
 *   pasted into a conversation. A prepared copy is the same photo again at
 *   another shape; when a product uses it, it shows under Product images.
 * ★ An edited photo is one of possibly many backgrounds a merchant tried for
 *   one product photo; listing every one would fill the Library with near
 *   copies. The one a product uses shows under Product images.
 */
export const LIBRARY_HIDDEN_SOURCES: readonly MediaSource[] = [
  "mink_attachment",
  "mink_prepared",
  "mink_edited",
];

export function isMediaSource(value: unknown): value is MediaSource {
  return (
    typeof value === "string" &&
    (MEDIA_SOURCES as readonly string[]).includes(value)
  );
}

/** A short label for a Library tile, or null for an ordinary upload. */
export function mediaSourceLabel(
  source: string | null | undefined,
): string | null {
  switch (source) {
    case "mink_generated":
      return "Made by Mink AI";
    case "mink_refined":
      return "Refined with Mink AI";
    case "mink_edited":
      return "Background changed";
    default:
      return null;
  }
}
