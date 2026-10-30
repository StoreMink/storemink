import type { Metadata } from "next";
import { STOREMINK_LOGO } from "@/lib/brand-assets";
import { brandOgImageUrl } from "@/lib/seo/og-card";
import {
  BRAND_DESCRIPTION,
  BRAND_TAGLINE,
  BRAND_TAGLINE_DETAIL,
} from "@/lib/seo/brand-identity";
import { getPlanPricing } from "@/lib/plans/pricing";
import { PLAN_IDS } from "@/lib/plans";
import { getPublicTaxSource } from "@/lib/billing/public-tax";
import { priceGstSuffix } from "@/lib/billing/tax-copy";
import { termsAt } from "@/lib/billing/tax-terms";
import { logError } from "@/lib/observability/logger";
import "./platform.css";

// Branded share card for the platform itself. metadataBase is PLATFORM_URL
// (set on the root layout), so this relative path resolves to storemink.com.
// The logo is a path under public/brand — the route inlines it off disk; a
// share card is the one image you never get a second chance at, so it must not
// depend on a network fetch while a crawler waits.
const OG_IMAGE = brandOgImageUrl({
  title: "StoreMink",
  // Both lines of the lockup: 66 characters, inside the route's 90 clamp.
  subtitle: `${BRAND_TAGLINE} ${BRAND_TAGLINE_DETAIL}`,
  color: "#17130f",
  logo: STOREMINK_LOGO,
  footer: "storemink.com",
});

// generateMetadata, not a constant: the description quotes a PRICE, and this
// one said "from ₹500/month" long after Basic moved to ₹1,500 — sitting in
// every WhatsApp and social preview of the site. Deriving it from the same
// resolved pricing the page renders means it cannot drift again, including
// after an operator reprices from the console.
//
// ★ GST (design 7.1): "/month plus GST" or "/month including GST" while GST is
// charged, from the cached public source worked out for this render. A failed
// read says nothing about GST either way.
export async function generateMetadata(): Promise<Metadata> {
  const [pricing, taxSource] = await Promise.all([
    getPlanPricing(),
    getPublicTaxSource().catch((error: unknown) => {
      logError("billing.public_tax.read_failed", error, { page: "metadata" });
      return null;
    }),
  ]);
  const terms = taxSource ? termsAt(taxSource, new Date()) : null;
  const cheapestPaid = Math.min(
    ...PLAN_IDS.map((id) => pricing[id].monthlyInr).filter((n) => n > 0),
  );
  const DESCRIPTION = `${BRAND_TAGLINE_DETAIL} ${BRAND_DESCRIPTION} Paid plans start at ₹${cheapestPaid.toLocaleString("en-IN")}/month${terms ? priceGstSuffix(terms) : ""} with 0% StoreMink transaction fees.`;

  return {
    title: `StoreMink: ${BRAND_TAGLINE}`,
    description: DESCRIPTION,
    applicationName: "StoreMink",
    // Self-canonical. Without this the apex emitted NO canonical at all, while
    // `/`, `/signup` and `/login` all served a byte-identical title and the same
    // og:url — three indexable copies of the one page that has to win the brand
    // query. Child routes override this with their own canonical.
    alternates: { canonical: "/" },
    keywords: [
      "storemink",
      "StoreMink",
      "storemink.com",
      "Storemink",
      "ecommerce store builder",
      "online store builder",
      "no code store builder india",
      "ecommerce platform india",
      "sell online in india",
      "B2B ecommerce platform",
      "D2C store builder",
      "create online store",
      "0% transaction fee ecommerce",
      "shopify alternative india",
    ],
    openGraph: {
      title: `StoreMink: ${BRAND_TAGLINE}`,
      description: DESCRIPTION,
      url: "/",
      siteName: "StoreMink",
      type: "website",
      images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "StoreMink" }],
    },
    twitter: {
      card: "summary_large_image",
      title: `StoreMink: ${BRAND_TAGLINE}`,
      description: DESCRIPTION,
      images: [OG_IMAGE],
    },
  };
}

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="stq">{children}</div>;
}
