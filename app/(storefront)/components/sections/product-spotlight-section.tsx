import Image from "next/image";
import Link from "next/link";
import type {
  ProductSpotlightConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { effectivePricing, formatPrice } from "@/lib/pricing";
import type { ShopCardProduct } from "../shop-card";
import { SectionShell } from "./section-shell";

// One product, large: its photograph, name and price from the catalogue
// beside authored copy and a link to its page. The product is resolved by
// lib/sections/map-data.ts (the chosen id, or the first featured product),
// so this renders nothing rather than an empty frame when there is none.

export function ProductSpotlightSection({
  sectionId,
  style,
  config,
  product,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: ProductSpotlightConfig;
  product: ShopCardProduct | null;
}) {
  if (!product) return null;
  const pricing = effectivePricing(product);
  const href = `/shop/${product.slug}`;

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div className={`home-spotlight media-${config.media_position}`}>
        <Link href={href} className="home-spotlight-media">
          {product.image_url && (
            <Image
              src={product.image_url}
              alt={product.name}
              fill
              sizes="(max-width: 760px) 100vw, 50vw"
              className="home-spotlight-image"
            />
          )}
        </Link>
        <div className="home-spotlight-copy">
          {config.eyebrow && (
            <p className="home-section-eyebrow">{config.eyebrow}</p>
          )}
          <h2 className="home-spotlight-heading">
            {config.heading || product.name}
          </h2>
          {config.heading && (
            <p className="home-spotlight-product">{product.name}</p>
          )}
          {config.show_price && pricing.selling > 0 && (
            <p className="home-spotlight-price">
              {pricing.hasVariants && (
                <span className="home-spotlight-from">from </span>
              )}
              <span className="home-spotlight-selling">
                {formatPrice(pricing.selling)}
              </span>
              {pricing.base > pricing.selling && (
                <s className="home-spotlight-base">
                  {formatPrice(pricing.base)}
                </s>
              )}
            </p>
          )}
          {config.body && <p className="home-spotlight-body">{config.body}</p>}
          <Link className="home-spotlight-cta sm-btn-primary" href={href}>
            {config.cta_label || "View product"}
          </Link>
        </div>
      </div>
    </SectionShell>
  );
}
