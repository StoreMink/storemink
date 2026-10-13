import "server-only";

import { and, eq } from "drizzle-orm";
import { productVariants, products } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { variantEffectiveSelling } from "@/lib/pricing";
import { resolveFulfilmentLocation } from "@/lib/fulfilment/resolve";
import { manualShippingOption, packageForShippingLines } from "./rates";
import { quoteShippingForOrder, readShippingSettings } from "./quote";
import type { CheckoutShippingOption } from "./types";

// ---------------------------------------------------------------------------
// "Can you deliver this to my PIN?" for one published product, the question
// the product page's PIN check asks (app/actions/shipping-actions.ts
// getProductDeliveryEstimate) and customer-facing Mink asks on WhatsApp
// (lib/whatsapp/mink-answer.ts). The STORE is an argument, never the host:
// the webhook path has no request to resolve a host from. The action owns the
// public gate (input shape, the per-IP rate limit, the host store) and calls
// this for the answer, so the two cannot quote differently.
// ---------------------------------------------------------------------------

export interface ProductDeliveryEstimate {
  available: boolean;
  postalCode: string;
  kind: "physical" | "digital";
  option?: CheckoutShippingOption;
  alternativeCount?: number;
  error?: string;
}

export async function estimateProductDelivery(
  storeId: string,
  input: {
    productId: string;
    variantId: string | null;
    quantity: number;
    /** Six digits, already validated by the caller. */
    postalCode: string;
  },
): Promise<ProductDeliveryEstimate> {
  const { postalCode } = input;
  const [productRows, variantRows, shippingSettings] = await Promise.all([
    withService((db) =>
      db
        .select({
          id: products.id,
          status: products.status,
          price: products.sellingPrice,
          basePrice: products.basePrice,
          trackInventory: products.trackInventory,
          allowBackorder: products.allowBackorder,
          onlineStock: products.onlineStock,
          requiresShipping: products.requiresShipping,
          weightGrams: products.weightGrams,
          lengthCm: products.lengthCm,
          widthCm: products.widthCm,
          heightCm: products.heightCm,
        })
        .from(products)
        .where(
          and(
            eq(products.storeId, storeId),
            eq(products.id, input.productId),
            eq(products.status, "published"),
          ),
        )
        .limit(1),
    ),
    input.variantId
      ? withService((db) =>
          db
            .select({
              id: productVariants.id,
              productId: productVariants.productId,
              price: productVariants.sellingPrice,
              basePrice: productVariants.basePrice,
              specialPrice: productVariants.specialPrice,
              trackInventory: productVariants.trackInventory,
              allowBackorder: productVariants.allowBackorder,
              onlineStock: productVariants.onlineStock,
              requiresShipping: productVariants.requiresShipping,
              weightGrams: productVariants.weightGrams,
              lengthCm: productVariants.lengthCm,
              widthCm: productVariants.widthCm,
              heightCm: productVariants.heightCm,
            })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.storeId, storeId),
                eq(productVariants.id, input.variantId!),
                eq(productVariants.productId, input.productId),
              ),
            )
            .limit(1),
        )
      : Promise.resolve([]),
    readShippingSettings(storeId),
  ]);
  const product = productRows[0];
  const variant = variantRows[0];
  if (!product || (input.variantId && !variant)) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error: "This product is no longer available.",
    };
  }

  const trackInventory = variant?.trackInventory ?? product.trackInventory;
  const allowBackorder = variant?.allowBackorder ?? product.allowBackorder;
  const onlineStock = variant?.onlineStock ?? product.onlineStock;
  if (trackInventory && !allowBackorder && onlineStock < input.quantity) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error:
        onlineStock <= 0
          ? "This item is currently out of stock for online delivery."
          : `Only ${onlineStock} available for online delivery.`,
    };
  }

  const requiresShipping =
    variant?.requiresShipping ?? product.requiresShipping;
  if (!requiresShipping) {
    return {
      available: true,
      postalCode,
      kind: "digital",
      option: {
        id: "digital:none",
        label: "Available immediately",
        description: "No physical delivery required",
        amount: 0,
        carrierCost: null,
        courierId: null,
        courierName: null,
        estimatedDeliveryMinDays: null,
        estimatedDeliveryMaxDays: null,
        estimatedDeliveryAt: null,
        freeShippingApplied: true,
      },
    };
  }

  // The special-price rule comes from lib/pricing, not a copy of it: this used
  // to inline `special ?? selling` while the checkout quote omitted the rule
  // altogether, so the two quotes valued the same sale cart differently.
  const variantUnit = variant
    ? variantEffectiveSelling({
        selling_price: variant.price,
        special_price: variant.specialPrice,
      })
    : 0;
  const unitPrice = variant
    ? variantUnit > 0
      ? variantUnit
      : variant.basePrice
    : product.price > 0
      ? product.price
      : product.basePrice;
  const line = {
    productId: product.id,
    variantId: variant?.id ?? null,
    quantity: input.quantity,
    needsStock: trackInventory && !allowBackorder,
    requiresShipping: true,
    weightGrams: variant?.weightGrams ?? product.weightGrams,
    lengthCm: variant?.lengthCm ?? product.lengthCm,
    widthCm: variant?.widthCm ?? product.widthCm,
    heightCm: variant?.heightCm ?? product.heightCm,
  };
  const merchandiseSubtotal = unitPrice * input.quantity;
  const quote =
    shippingSettings.mode === "shiprocket"
      ? await quoteShippingForOrder({
          storeId,
          fulfilmentLocationId: await resolveFulfilmentLocation(storeId, [
            line,
          ]),
          deliveryPostcode: postalCode,
          cod: false,
          merchandiseSubtotal,
          parcel: packageForShippingLines([line]),
          settings: shippingSettings,
        })
      : {
          options: [
            manualShippingOption(shippingSettings, merchandiseSubtotal),
          ],
        };
  const option = quote.options[0];
  if (!option) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error: quote.error ?? "Delivery is not available for this PIN code.",
    };
  }
  return {
    available: true,
    postalCode,
    kind: "physical",
    option,
    alternativeCount: Math.max(0, quote.options.length - 1),
  };
}
