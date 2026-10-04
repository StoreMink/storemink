/** Shared validation for the exact ordered gallery in a product-photo approval. */
export function parseMinkProductImages(value: unknown): string[] {
  if (typeof value !== "string")
    throw new Error("Gallery photos must be a JSON list.");
  let urls: unknown;
  try {
    urls = JSON.parse(value);
  } catch {
    throw new Error("Gallery photos must be a JSON list.");
  }
  if (
    !Array.isArray(urls) ||
    urls.length > 20 ||
    urls.some((url) => typeof url !== "string" || url.length > 2048)
  )
    throw new Error("Use at most 20 gallery photos.");
  return urls;
}
