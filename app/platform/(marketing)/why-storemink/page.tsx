import {
  BadgePercent,
  Boxes,
  FileSpreadsheet,
  IndianRupee,
  Layers,
  Rocket,
  Sparkles,
  Store,
} from "lucide-react";
import { POS_URL } from "@/lib/site";
import { CommerceCommandCentre, MinkArt } from "../../homepage-art";
import { InvoiceArt, RegisterArt } from "../../product-art";
import {
  CtaBand,
  FeatureRow,
  FeatureRows,
  PageHero,
  PillarGrid,
  marketingMetadata,
} from "../blocks";

export const metadata = marketingMetadata({
  path: "/why-storemink",
  title: "Why StoreMink",
  description:
    "One platform for the way India sells: a storefront, orders, inventory, Point of Sale and Mink AI together, priced in rupees with 0% StoreMink transaction fee.",
});

export default function WhyStoreMinkPage() {
  return (
    <>
      <PageHero
        label="Why StoreMink"
        title={
          <>
            One platform for the way <em>India sells.</em>
          </>
        }
        lead="Most tools were built somewhere else and adapted. StoreMink was built here: rupee plans, GST invoices, cash on delivery, pickup in store and a counter that shares stock with your website."
        secondary={{ href: "/products", text: "See the products" }}
      >
        <CommerceCommandCentre />
      </PageHero>

      <PillarGrid
        label="What you get"
        title="Everything behind your brand. Nothing to stitch together."
        lead="A storefront, the dashboard that runs it, the counter in your shop and the AI that helps with all three. One login, one catalogue, one customer list."
        columns={4}
        pillars={[
          {
            icon: <Rocket size={20} />,
            title: "Get started fast",
            body: "Pick a theme, add products and your store is live on its own subdomain. Your own domain when you are ready.",
            href: "/products/online-store",
          },
          {
            icon: <IndianRupee size={20} />,
            title: "Keep every rupee",
            body: "Connect your own payment gateway. StoreMink charges the plan price, never a percentage of your sales.",
            href: "/products/payments",
          },
          {
            icon: <Store size={20} />,
            title: "Online and in person",
            body: "Point of Sale uses the same products, customers and stock as your website, across every location.",
            href: POS_URL,
            linkText: "Explore Point of Sale",
          },
          {
            icon: <Sparkles size={20} />,
            title: "AI that knows your store",
            body: "Mink answers from your own data and prepares drafts you review. Credits are included on every plan.",
            href: "/products/mink-ai",
          },
        ]}
      />

      <FeatureRows>
        <FeatureRow
          label="Built for India"
          title="GST-ready from the first invoice."
          points={[
            "Inclusive or exclusive GST pricing per product",
            "HSN codes and CGST/SGST breakdowns on every invoice",
            "Cash on delivery out of the box",
            "Shiprocket fulfilment with your own account",
          ]}
          link={{ href: "/products/payments", text: "Payments & GST" }}
          art={<InvoiceArt />}
          tone="cream"
        >
          Set your tax classes once. StoreMink prepares a clear, printable
          invoice for every order, whether it was placed online or rung up at
          the counter.
        </FeatureRow>
        <FeatureRow
          label="One operation"
          title="Your website and your counter, finally on the same page."
          points={[
            "Barcode search, held sales and split payments",
            "Stock per location, with transfers between shops",
            "Buy online, collect in store",
            "Returns and store credit at the counter",
          ]}
          link={{
            href: POS_URL,
            text: "Explore Point of Sale",
            external: true,
          }}
          art={<RegisterArt />}
          tone="mint"
        >
          Sell from a computer, tablet or phone. Products, customers and stock
          stay connected to your online store in real time, so a sale in the
          shop updates the website and a web order can be collected from the
          shop.
        </FeatureRow>
        <FeatureRow
          label="AI-native"
          title="Meet your secret weapon, Mink."
          points={[
            "Permission-aware answers from your store data",
            "Private, editable drafts: nothing publishes itself",
            "Mink credits included on every plan",
          ]}
          link={{ href: "/products/mink-ai", text: "Meet Mink AI" }}
          art={<MinkArt />}
          tone="navy"
        >
          Ask which products are low on stock, what sold last week, or for a
          launch email. Mink reads your own data and hands you something to
          review, never something it has already sent.
        </FeatureRow>
      </FeatureRows>

      <section id="switch">
        <PillarGrid
          label="Switch to StoreMink"
          title="Bring your store with you."
          lead="Moving is a CSV, not a rebuild. Imports keep your handles, variants and stock, and nothing you bring is ever deleted by a plan change."
          columns={3}
          tone="white"
          pillars={[
            {
              icon: <FileSpreadsheet size={20} />,
              title: "Import your catalogue",
              body: "Products, categories, inventory and coupons import from a Shopify-shaped CSV. Bad rows are reported by line; the rest import.",
            },
            {
              icon: <Layers size={20} />,
              title: "Keep your look",
              body: "Choose a theme, then shape every page in the visual builder. Add your own code on paid plans when the builder is not enough.",
            },
            {
              icon: <Boxes size={20} />,
              title: "Nothing is lost on a downgrade",
              body: "If a payment fails or you move to a lower plan, your products, settings, content and history all stay. Gated features pause; upgrading restores them.",
            },
          ]}
        />
      </section>

      <PillarGrid
        label="Simple pricing"
        title="Start free. Grow for less."
        columns={3}
        pillars={[
          {
            icon: <BadgePercent size={20} />,
            title: "0% transaction fee",
            body: "Every plan, every order. Customer payments settle to your own gateway and StoreMink takes nothing from them.",
            href: "/pricing",
            linkText: "See plans",
          },
          {
            icon: <IndianRupee size={20} />,
            title: "Priced in rupees",
            body: "Monthly or yearly, with two months free on yearly. No currency surprises on your card statement.",
            href: "/pricing",
            linkText: "See plans",
          },
          {
            icon: <Rocket size={20} />,
            title: "Free plan forever",
            body: "A real storefront on your own subdomain, the full dashboard, GST invoicing and cash on delivery, with no card needed.",
            href: "/signup",
            linkText: "Create your store",
          },
        ]}
      />

      <CtaBand />
    </>
  );
}
