import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { DASHBOARD_PAGE_SIZE, pickPage } from "../lib/list-params";
import { MediaLibraryView, type LibraryTile } from "./media-library-view";
import { countLibraryAssets, listLibraryAssets } from "@/lib/media/library";
import {
  countProductImages,
  listProductImages,
  productImageUsage,
} from "@/lib/media/product-images";
import type { ProductImageItem } from "@/lib/media/library-types";

// Two tabs: the Library (uploads and the pictures Mink AI made or refined; chat
// attachments and resized copies are not listed, lib/media/sources.ts) and
// Product images (every photo a product uses, read from the products, so a
// photo uploaded in the product editor is here without a library row).
export default async function MediaDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireSectionAccess("media", "view");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const pageSize = DASHBOARD_PAGE_SIZE;
  const storeId = await getActingStoreId();
  // Product images names products, so it follows the products permission.
  const canSeeProducts = access.can("products", "view");
  const tab = sp.tab === "products" && canSeeProducts ? "products" : "library";

  let assets: LibraryTile[] = [];
  let productImages: ProductImageItem[] = [];
  let libraryTotal = 0;
  let productTotal = 0;
  let loadError = false;
  try {
    if (tab === "library") {
      const listed = await listLibraryAssets(storeId, { page, pageSize });
      libraryTotal = listed.total;
      // ★ Best-effort: without it the tiles lose their "used by" note, and
      //   deleteMediaAsset still refuses an image a product uses.
      const usage = await productImageUsage(
        storeId,
        listed.assets.map((a) => a.url),
      ).catch(() => new Map());
      assets = listed.assets.map((asset) => ({
        ...asset,
        products: usage.get(asset.url) ?? [],
      }));
      if (canSeeProducts) {
        productTotal = await countProductImages(storeId).catch(() => 0);
      }
    } else {
      const listed = await listProductImages(storeId, { page, pageSize });
      productImages = listed.items;
      productTotal = listed.total;
      libraryTotal = await countLibraryAssets(storeId).catch(() => 0);
    }
  } catch (err) {
    loadError = true;
    console.error(
      "MediaDashboardPage load:",
      err instanceof Error ? err.message : err,
    );
  }

  return (
    <MediaLibraryView
      tab={tab}
      assets={assets}
      productImages={productImages}
      libraryTotal={libraryTotal}
      productTotal={productTotal}
      canSeeProducts={canSeeProducts}
      loadError={loadError}
      page={page}
      pageSize={pageSize}
    />
  );
}
