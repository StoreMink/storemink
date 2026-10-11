import { PRODUCT_PAGES } from "../../../marketing-routes";
import { InvoiceArt, RegisterArt } from "../../../product-art";
import {
  CtaBand,
  FeatureRow,
  FeatureRows,
  PageHero,
  PillarGrid,
  RelatedPages,
  marketingMetadata,
} from "../../blocks";

export const metadata = marketingMetadata({
  path: "/products/payments",
  title: "Payments & GST",
  description:
    "Take payments through your own gateway with 0% StoreMink transaction fee, offer cash on delivery, and issue GST invoices with HSN codes and CGST/SGST breakdowns.",
});

export default function PaymentsPage() {
  return (
    <>
      <PageHero
        label="Payments & GST"
        title={
          <>
            Keep every rupee. <em>Invoice it properly.</em>
          </>
        }
        lead="Connect your own payment gateway and customer payments settle straight to you. StoreMink charges the plan price, never a percentage of your sales, and prepares a GST invoice for every order."
        secondary={{ href: "/pricing", text: "See plans" }}
      />

      <FeatureRows>
        <FeatureRow
          label="Payments"
          title="Your gateway. Your money. 0% to us."
          points={[
            "Connect your own Razorpay account in Channels",
            "Cash on delivery on every plan, including Free",
            "Store credit and split payments at the counter",
            "Pay at the counter when collecting a pickup order",
          ]}
          art={<RegisterArt compact />}
          tone="mint"
        >
          The storefront offers online payment and cash on delivery; the counter
          takes cash, card, UPI, store credit or any split of them. Every
          payment is recorded against the order, so refunds and shift
          reconciliation add up.
        </FeatureRow>
        <FeatureRow
          label="GST"
          title="GST-ready from the first invoice."
          points={[
            "Tax classes per product, inclusive or exclusive pricing",
            "HSN codes and CGST, SGST or IGST by place of supply",
            "Printable invoices online and credit notes for refunds",
            "Buyer GSTIN captured at the counter for business customers",
          ]}
          art={<InvoiceArt />}
          tone="cream"
        >
          Set your tax classes and business details once. Every order, whether
          from the website or the till, gets a numbered invoice with the tax
          broken down the way your accountant expects.
        </FeatureRow>
      </FeatureRows>

      <PillarGrid
        label="Money, handled carefully"
        title="The rules that stop a payment going wrong."
        columns={4}
        pillars={[
          {
            title: "Prices are re-checked",
            body: "Every order is re-priced from your catalogue on the server. A tampered cart cannot change what is charged.",
          },
          {
            title: "Paid means paid",
            body: "An online payment is confirmed with the gateway before an order is marked paid, and reconciled again if a tab is closed.",
          },
          {
            title: "Refunds never double",
            body: "A refund is recorded before the money moves and matched back by reference, so a retry cannot pay twice.",
          },
          {
            title: "Nothing deleted on downgrade",
            body: "Invoices, orders and payment history stay with your store whatever plan you are on.",
          },
        ]}
      />

      <RelatedPages
        pages={PRODUCT_PAGES.filter((p) => p.path !== "/products/payments")}
      />

      <CtaBand />
    </>
  );
}
