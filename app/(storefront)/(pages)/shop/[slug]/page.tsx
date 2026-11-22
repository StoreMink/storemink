import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import {
  categories,
  productReviews,
  productVariants,
  products,
} from "@/drizzle/schema";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getStorefrontLayout } from "@/lib/store/storefront-layout";
import { getStoreSetting } from "@/lib/settings/resolve";
import { effectivePricing } from "@/lib/pricing";
import { loadOffersForStorefront } from "@/lib/offers/cart";
import { offerBadgeFor, offerTagFor } from "@/lib/offers/badge";
import { getStoreBrand } from "@/lib/store/brand";
import { getStoreUrl } from "@/lib/site";
import { getOgImageUrl } from "@/lib/og-image";
import { variantEffectiveSelling } from "@/lib/pricing";
import { productSchema, breadcrumbSchema } from "@/lib/seo/schema";
import { JsonLd } from "@/app/(storefront)/components/json-ld";
import { normalizeOptions } from "@/lib/products/options";
import ProductDetailClient, {
  type DetailProduct,
} from "./product-detail-client";
import { sanitizeBlogContent } from "@/lib/sanitize";
import type { ProductTemplate } from "@/lib/themes/templates";
import { maskBlockedMedia } from "@/lib/moderation/blocked-objects";
import { PLACEHOLDER_URL_PATH } from "@/lib/moderation/placeholder";

/** A template's rich-text block is stored HTML (a theme's or the merchant's),
 *  so it is sanitised here, at the render boundary, before it reaches the
 *  client bundle — the rich-text section's rule. */
function sanitizedProductTemplate(template: ProductTemplate): ProductTemplate {
  return {
    ...template,
    blocks: template.blocks.map((block) =>
      block.type === "rich_text"
        ? { ...block, html: sanitizeBlogContent(block.html) }
        : block,
    ),
  };
}
import type { RelatedProduct } from "./related-products";
import type { ProductReview } from "./reviews-section";
import "../shop.css";

/** True for an address that names a real picture: not empty, and not the
 *  placeholder the takedown page swap puts where a blocked image was. The
 *  JSON-LD image list and the share image leave the placeholder out, so a
 *  search engine or a chat preview is never handed "Image not available". */
function isShownImage(url: string | null | undefined): url is string {
  return !!url && !url.includes(PLACEHOLDER_URL_PATH);
}

// The storefront layout renders dynamically so saved catalogue changes appear
// on the next request; there is no persistent product-page cache.

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ variant?: string | string[] }>;
};

// Wrapped in React.cache so the page body and generateMetadata share ONE query
// per render instead of fetching the same product row twice.
const getProduct = cache(
  async (slug: string, storeId: string): Promise<DetailProduct | null> => {
    try {
      const product = await withAnon(async (db) => {
        const rows = await db
          .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            description: products.description,
            category_id: products.categoryId,
            base_price: products.basePrice,
            selling_price: products.sellingPrice,
            image_url: products.imageUrl,
            images: products.images,
            seo_title: products.seoTitle,
            seo_description: products.seoDescription,
            track_inventory: products.trackInventory,
            stock: products.onlineStock,
            low_stock_threshold: products.lowStockThreshold,
            allow_backorder: products.allowBackorder,
            returnable: products.returnable,
            options: products.options,
            cat_id: categories.id,
            cat_name: categories.name,
            cat_slug: categories.slug,
            cat_status: categories.status,
          })
          .from(products)
          .leftJoin(categories, eq(products.categoryId, categories.id))
          .where(
            and(
              eq(products.storeId, storeId),
              eq(products.slug, slug),
              eq(products.status, "published"),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return null;

        const variants = await db
          .select({
            id: productVariants.id,
            name: productVariants.name,
            base_price: productVariants.basePrice,
            selling_price: productVariants.sellingPrice,
            special_price: productVariants.specialPrice,
            sku: productVariants.sku,
            images: productVariants.images,
            sort_order: productVariants.sortOrder,
            track_inventory: productVariants.trackInventory,
            stock: productVariants.onlineStock,
            low_stock_threshold: productVariants.lowStockThreshold,
            allow_backorder: productVariants.allowBackorder,
            option_values: productVariants.optionValues,
          })
          .from(productVariants)
          .where(eq(productVariants.productId, row.id))
          .orderBy(asc(productVariants.sortOrder));

        const {
          cat_id,
          cat_name,
          cat_slug,
          cat_status,
          options: rawOptions,
          ...productFields
        } = row;
        // Stored options are re-normalised on read: a row the checks below
        // would refuse renders as the flat list instead of a broken picker.
        const normalized = normalizeOptions(rawOptions);
        return {
          ...productFields,
          options: "options" in normalized ? normalized.options : [],
          images: productFields.images ?? [],
          category: cat_id
            ? {
                id: cat_id,
                name: cat_name!,
                slug: cat_slug!,
                status: cat_status!,
              }
            : null,
          variants,
        };
      });
      // The takedown page swap runs AFTER the read scope has closed: it may
      // open its own service scope to reload the blocked set, and a scope must
      // never open inside another's callback. A blocked product itself never
      // reaches here (RLS hides it from the anonymous read); this swaps a
      // blocked picture on a product that is still shown.
      return product ? await maskBlockedMedia(product) : null;
    } catch (err) {
      console.error("getProduct:", err instanceof Error ? err.message : err);
      return null;
    }
  },
);

// This page resolves the store from the request host (requireStorefrontStoreId), so it
// renders per-store/per-request — no generateStaticParams (a slug can exist in
// more than one store). The underlying reads stay cheap via the data cache.

// Other published products in the same category (excluding the current one).
async function getRelated(
  categoryId: string | null,
  excludeId: string,
  storeId: string,
): Promise<RelatedProduct[]> {
  if (!categoryId) return [];
  try {
    const related = await withAnon(async (db) => {
      // Category name flattened via the join for the card eyebrow.
      const rows = await db
        .select({
          id: products.id,
          name: products.name,
          slug: products.slug,
          base_price: products.basePrice,
          selling_price: products.sellingPrice,
          image_url: products.imageUrl,
          images: products.images,
          card_color: products.cardColor,
          featured: products.featured,
          track_inventory: products.trackInventory,
          stock: products.onlineStock,
          low_stock_threshold: products.lowStockThreshold,
          allow_backorder: products.allowBackorder,
          category: categories.name,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(
          and(
            eq(products.storeId, storeId),
            eq(products.status, "published"),
            eq(products.categoryId, categoryId),
            ne(products.id, excludeId),
          ),
        )
        .orderBy(asc(products.sortOrder))
        .limit(4);
      if (rows.length === 0) return [];

      const variantRows = await db
        .select({
          product_id: productVariants.productId,
          base_price: productVariants.basePrice,
          selling_price: productVariants.sellingPrice,
          special_price: productVariants.specialPrice,
          sort_order: productVariants.sortOrder,
          track_inventory: productVariants.trackInventory,
          stock: productVariants.onlineStock,
          low_stock_threshold: productVariants.lowStockThreshold,
          allow_backorder: productVariants.allowBackorder,
        })
        .from(productVariants)
        .where(
          inArray(
            productVariants.productId,
            rows.map((r) => r.id),
          ),
        );
      const byProduct = new Map<string, RelatedProduct["variants"]>();
      for (const { product_id, ...variant } of variantRows) {
        const list = byProduct.get(product_id) ?? [];
        list.push(variant);
        byProduct.set(product_id, list);
      }
      return rows.map((r) => ({ ...r, variants: byProduct.get(r.id) ?? [] }));
    });
    return await maskBlockedMedia(related);
  } catch (err) {
    console.error("getRelated:", err instanceof Error ? err.message : err);
    return [];
  }
}

// Public reviews for a product, newest first.
async function getReviews(
  productId: string,
  storeId: string,
): Promise<ProductReview[]> {
  try {
    const reviews = await withAnon((db) =>
      db
        .select({
          id: productReviews.id,
          user_id: productReviews.userId,
          author_name: productReviews.authorName,
          rating: productReviews.rating,
          comment: productReviews.comment,
          created_at: productReviews.createdAt,
        })
        .from(productReviews)
        .where(
          and(
            eq(productReviews.storeId, storeId),
            eq(productReviews.productId, productId),
          ),
        )
        .orderBy(desc(productReviews.createdAt)),
    );
    // A blocked review is hidden by RLS; a shown one may still quote a
    // blocked picture's address in its text.
    return await maskBlockedMedia(reviews);
  } catch (err) {
    console.error("getReviews:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const storeId = await requireStorefrontStoreId();
  const product = await getProduct(slug, storeId);
  if (!product) return { title: "Product not found" };

  const brand = await getStoreBrand();
  // Layout templates the title as "%s | {brand}", so use the product name
  // (or its own SEO title) — never a hardcoded store name.
  const title = product.seo_title || product.name;
  const description =
    product.seo_description ||
    product.description ||
    `Shop ${product.name} at ${brand.name}.`;

  // A taken-down main photo arrives as the placeholder path; the share card
  // then carries no image rather than "Image not available".
  const ogImageUrl = getOgImageUrl(
    isShownImage(product.image_url) ? product.image_url : null,
  );

  return {
    title,
    description,
    alternates: { canonical: `/shop/${product.slug}` },
    openGraph: {
      title,
      description,
      url: `/shop/${product.slug}`,
      type: "website",
      images: ogImageUrl
        ? [
            {
              url: ogImageUrl,
              width: 1200,
              height: 630,
              alt: product.name,
            },
          ]
        : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ogImageUrl ? [ogImageUrl] : undefined,
    },
  };
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: PageProps) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  // `?variant=<id>` opens the page on that variant — the link a card swatch,
  // a shared URL or an ad points at. Anything else is ignored.
  const requestedVariant =
    typeof query.variant === "string" ? query.variant : null;
  const storeId = await requireStorefrontStoreId();
  const product = await getProduct(slug, storeId);

  if (!product) {
    notFound();
  }

  const [
    related,
    reviews,
    layout,
    brand,
    siteUrl,
    lowStockThreshold,
    showBadges,
    offerBundle,
  ] = await Promise.all([
    getRelated(product.category_id, product.id, storeId),
    getReviews(product.id, storeId),
    getStorefrontLayout(),
    getStoreBrand(),
    getStoreUrl(),
    getStoreSetting("inventory.lowStockThreshold"),
    getStoreSetting("offers.showBadges"),
    // Joins the same concurrent batch rather than adding a serial read, and
    // fails open to no offers on its own — a page that cannot show a marker
    // still sells. Same shape the shop listing uses.
    loadOffersForStorefront(storeId, null, []),
  ]);

  // ★★ THE PRODUCT PAGE HAD NO OFFER MARKER AT ALL. The shop GRID showed one
  // and the detail page — the screen a shopper reaches when they are actually
  // deciding — showed nothing, so an offer got quieter the closer someone came
  // to buying. Same two-step the grid uses: the per-unit saving where there is
  // one, otherwise the offer's terms, which is the only honest thing to say
  // about a buy-X-get-Y on a page showing a single item.
  const offerMarker = (() => {
    if (showBadges === false) return null;
    const priced = effectivePricing(product as never);
    const probe = {
      productId: product.id,
      categoryId: product.category_id ?? null,
      unitPrice: priced.selling,
      regularUnitPrice: priced.regularSelling,
    };
    const badge = offerBadgeFor(probe, offerBundle.offers, offerBundle.policy);
    if (badge) return badge.label;
    return (
      offerTagFor(probe, offerBundle.offers, offerBundle.policy)?.label ?? null
    );
  })();

  // Product / Breadcrumb JSON-LD (rich results: price, availability, stars).
  // Effective per-variant selling prices → an Offer (single price) or
  // AggregateOffer (a low–high range). Stock: in stock if any variant has some,
  // or if the product is unvariant'd (no per-product stock column to check).
  const variantPrices = product.variants.map((v) => {
    const eff = variantEffectiveSelling(v);
    return eff > 0 ? eff : v.base_price;
  });
  const prices = variantPrices.length
    ? variantPrices
    : [product.selling_price > 0 ? product.selling_price : product.base_price];
  let inStock = true;
  if (product.variants.length > 0) {
    inStock = !product.variants.every(
      (v) => v.track_inventory && !v.allow_backorder && v.stock <= 0,
    );
  } else {
    inStock = !(
      product.track_inventory &&
      !product.allow_backorder &&
      product.stock <= 0
    );
  }
  const ratingCount = reviews.length;
  const ratingValue = ratingCount
    ? reviews.reduce((sum, r) => sum + r.rating, 0) / ratingCount
    : 0;

  const productLd = productSchema({
    siteUrl,
    brandName: brand.name,
    name: product.name,
    slug: product.slug,
    description: product.seo_description || product.description,
    category: product.category?.name ?? null,
    images: [product.image_url, ...(product.images ?? [])].filter(isShownImage),
    price: { low: Math.min(...prices), high: Math.max(...prices) },
    inStock,
    rating: ratingCount ? { value: ratingValue, count: ratingCount } : null,
  });
  const breadcrumbLd = breadcrumbSchema(siteUrl, [
    { name: "Home", path: "/" },
    { name: "Shop", path: "/shop" },
    // A hidden category has no page, so it is not a breadcrumb step.
    ...(product.category && product.category.status === "active"
      ? [
          {
            name: product.category.name,
            path: `/collections/${product.category.slug}`,
          },
        ]
      : []),
    { name: product.name, path: `/shop/${product.slug}` },
  ]);

  // The product template comes partly from the installed theme's preset,
  // which no masked reader returns, so its stored HTML is swapped here.
  const template = await maskBlockedMedia(
    sanitizedProductTemplate(layout.templates.product),
  );

  return (
    <>
      <JsonLd data={[productLd, breadcrumbLd]} />
      <ProductDetailClient
        product={product}
        related={related}
        reviews={reviews}
        grocery={layout.productDetail === "grocery"}
        template={template}
        storeLowStockThreshold={lowStockThreshold as number}
        recentlyViewed={layout.recentlyViewed}
        offerMarker={offerMarker}
        requestedVariantId={requestedVariant}
      />
    </>
  );
}
