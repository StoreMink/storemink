// The first lines of a product's description, for a place that has room for
// a paragraph and not the whole text (the quick view). Pure, client-safe.
//
// A product description is plain text the merchant typed (the product page
// prints it inside a <p>), so this never has to understand markup: it only
// folds line breaks into spaces and cuts on a word.

/** Long enough for two or three sentences beside a photo. */
export const PRODUCT_EXCERPT_MAX = 280;

export function productExcerpt(
  text: string | null | undefined,
  max: number = PRODUCT_EXCERPT_MAX,
): string | null {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(" ");
  // A cut far back from the limit means one very long word: keep the limit.
  const kept = at > max * 0.6 ? cut.slice(0, at) : cut;
  // No dangling comma or dash before the ellipsis.
  return `${kept.replace(/[\s,;:.\-(]+$/, "")}…`;
}
