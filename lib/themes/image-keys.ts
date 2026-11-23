// ---------------------------------------------------------------------------
// Which keys of a section's settings hold a PICTURE the storefront renders.
//
// WHY (22 Nov 2026). The two functions that list a theme's pictures
// (validation.ts and theme-studio/contracts.ts `collectThemeImageUrls`)
// followed only the key `image_url`. A hero slide's phone photograph is
// `mobile_image_url`, so Theme Studio's picture check reported every one of
// them as "declared but nothing renders it", on every theme since each
// opening slide got a phone photograph. It is shown, on phones. The design
// review was handed that line as a finding, and three times on the first
// live theme it read it as a platform fault and failed a finished design.
//
// A video's `video_url` is not a picture and is not listed.
// Import-free, so both collectors can use it.
// ---------------------------------------------------------------------------

/** `image_url`, any `*_image_url` (a phone photograph), a video's poster and
 * a testimonial's or logo strip's logo. */
export function isImageUrlKey(key: string): boolean {
  return (
    key === "image_url" ||
    key.endsWith("_image_url") ||
    key === "poster_url" ||
    key === "logo_url"
  );
}
