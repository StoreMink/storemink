import "server-only";

import { getActingStoreId } from "@/app/dashboard/lib/access";
import { getStoreChrome } from "@/lib/chrome/queries";
import { productPhotoSpec } from "@/lib/media/image-specs";

/**
 * The product-photo size the editor recommends, from the store's PUBLISHED
 * card photo shape — what shoppers see, not an unpublished Builder draft.
 * A read failure falls back to portrait inside getStoreChrome.
 */
export async function storePhotoSpec(): Promise<"product" | "product_square"> {
  const chrome = await getStoreChrome(await getActingStoreId());
  return productPhotoSpec(chrome.appearance.cardPhoto);
}
