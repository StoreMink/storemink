import { platformOrganizationSchema } from "@/lib/seo/brand-identity";
import { PLATFORM_URL, POS_URL } from "@/lib/site";

export const POS_PRODUCT_DESCRIPTION =
  "StoreMink Point of Sale connects in-store sales with the same catalogue, location-level stock, customers and orders as a StoreMink website.";

// Every item is stated visibly on the POS page. Structured data must describe
// the page users actually see; adding roadmap promises here would be misleading
// even if the JSON-LD remained technically valid.
export const POS_FEATURES = [
  "Barcode scanning with a scanner or phone camera",
  "Staff PIN sign-in and authorised POS devices",
  "POS shifts, cash float, drops, counts and variance",
  "Location-level inventory, stock counts and transfers",
  "GST receipts with CGST, SGST and HSN details",
  "Buy online and collect in store",
  "Cash, card, UPI and split tender recording",
  "Owner-controlled discounts with caps and manager approval",
  "Browser-based operation with no proprietary terminal required",
] as const;

/**
 * ★ `vatIncluded` is the GST flag the price box beside it states
 * (`valueAddedTaxIncluded` in tax-copy.ts): true while GST is included, false
 * while it is added on top, and absent while GST is off, scheduled or its
 * read failed, the homepage's rule. Without it a search result could show the
 * bare price as all-in while GST is added to it (R2-05).
 */
export function buildPosStructuredData(input: {
  proMonthlyEquivalentInr: number;
  vatIncluded?: boolean;
}): Record<string, unknown> {
  const publisher = { "@id": `${PLATFORM_URL}/#organization` };

  return {
    "@context": "https://schema.org",
    "@graph": [
      // Use the shared builder so the company identity, logo and official
      // profiles cannot drift between storemink.com and pos.storemink.com.
      platformOrganizationSchema(),
      {
        "@type": "WebSite",
        "@id": `${POS_URL}/#website`,
        name: "StoreMink Point of Sale",
        alternateName: "StoreMink POS",
        url: POS_URL,
        inLanguage: "en-IN",
        publisher,
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${POS_URL}/#software`,
        name: "StoreMink Point of Sale",
        alternateName: "StoreMink POS",
        description: POS_PRODUCT_DESCRIPTION,
        url: POS_URL,
        mainEntityOfPage: { "@id": `${POS_URL}/#website` },
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Retail point of sale software",
        operatingSystem: "Any device with a modern web browser",
        browserRequirements:
          "Requires a modern web browser and an internet connection to complete sales.",
        areaServed: "IN",
        publisher,
        provider: publisher,
        isPartOf: { "@id": `${PLATFORM_URL}/#software` },
        featureList: [...POS_FEATURES],
        offers: {
          "@type": "Offer",
          name: "StoreMink Pro, annual billing",
          description:
            "Point of Sale is included with StoreMink Pro for two locations.",
          price: input.proMonthlyEquivalentInr,
          priceCurrency: "INR",
          url: `${PLATFORM_URL}/#pricing`,
          availability: "https://schema.org/InStock",
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            name: "Monthly equivalent, billed annually",
            price: input.proMonthlyEquivalentInr,
            priceCurrency: "INR",
            billingDuration: 12,
            billingIncrement: 1,
            unitCode: "MON",
            referenceQuantity: {
              "@type": "QuantitativeValue",
              value: 1,
              unitCode: "MON",
            },
            ...(input.vatIncluded === undefined
              ? {}
              : { valueAddedTaxIncluded: input.vatIncluded }),
          },
        },
      },
    ],
  };
}
