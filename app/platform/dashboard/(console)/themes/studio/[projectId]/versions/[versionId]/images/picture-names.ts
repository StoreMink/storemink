// ---------------------------------------------------------------------------
// A picture slot's name in words (wave TS-2, builder 2C). Pure, and
// server-safe and client-safe: the Pictures tab and the Checks tab name a
// slot on the server (the Redraw confirm's list), the picture editor names
// it in the browser, and both must say the same.
// ---------------------------------------------------------------------------

/** "hero-main" reads "Hero main"; "product_3-gallery" reads "Product 3
 * gallery". The slot's id stays the server's; this is only its name. */
export function pictureName(slotId: string): string {
  const words = slotId
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return "A picture";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
