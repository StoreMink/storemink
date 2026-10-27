import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { POS_URL } from "@/lib/site";
import { GrowthArt, MinkArt, OrderFlowArt } from "../../homepage-art";
import { PRODUCT_PAGES } from "../../marketing-routes";
import { InvoiceArt, RegisterArt, StorefrontArt } from "../../product-art";
import { CtaBand, PageHero, marketingMetadata } from "../blocks";

export const metadata = marketingMetadata({
  path: "/products",
  title: "Products",
  description:
    "Everything behind your brand: an online store, orders and inventory across locations, payments with GST invoices, customers and marketing, Point of Sale and Mink AI.",
});

// The overview: one card per product page, with the same drawn artwork the
// page itself leads with. The order follows a merchant's journey — build the
// store, run the orders, take the money, grow, then the AI across all of it.
const ART: Record<string, { node: React.ReactNode; tone: string }> = {
  "/products/online-store": { node: <StorefrontArt />, tone: "lilac" },
  "/products/orders-inventory": { node: <OrderFlowArt />, tone: "grey" },
  "/products/payments": { node: <InvoiceArt />, tone: "cream" },
  "/products/marketing": { node: <GrowthArt />, tone: "navy" },
  "/products/mink-ai": { node: <MinkArt />, tone: "navy" },
};

export default function ProductsPage() {
  return (
    <>
      <PageHero
        label="Products"
        title={
          <>
            Everything behind your brand. <em>In one place.</em>
          </>
        }
        lead="Build the store, run the orders, take the money, grow the customer list and sell at the counter, all from one dashboard with one catalogue."
        secondary={{ href: "/pricing", text: "See plans" }}
      />

      <section className="smm-pillars is-grey">
        <div className="smh-container">
          <div className="smm-product-grid">
            {PRODUCT_PAGES.map((page) => {
              const art = ART[page.path];
              return (
                <Link
                  key={page.path}
                  href={page.path}
                  className="smm-product-card"
                >
                  <div className={`smm-art is-${art.tone}`}>{art.node}</div>
                  <div className="smm-product-copy">
                    <h2>{page.label}</h2>
                    <p>{page.blurb}</p>
                    <span className="smh-text-link">
                      Explore {page.label} <ArrowRight size={15} />
                    </span>
                  </div>
                </Link>
              );
            })}
            <a href={POS_URL} className="smm-product-card">
              <div className="smm-art is-mint">
                <RegisterArt compact />
              </div>
              <div className="smm-product-copy">
                <h2>Point of Sale (POS)</h2>
                <p>
                  A POS for your shop that shares products, customers and stock
                  with your website. Shifts, staff PINs, pickups and returns at
                  the counter.
                </p>
                <span className="smh-text-link">
                  Explore Point of Sale <ArrowRight size={15} />
                </span>
              </div>
            </a>
          </div>
        </div>
      </section>

      <CtaBand />
    </>
  );
}
