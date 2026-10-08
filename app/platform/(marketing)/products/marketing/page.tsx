import { BarChart3, Mail, Star, Users } from "lucide-react";
import { ChannelsArt, GrowthArt } from "../../../homepage-art";
import { PRODUCT_PAGES } from "../../../marketing-routes";
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
  path: "/products/marketing",
  title: "Customers & marketing",
  description:
    "Turn first orders into repeat customers: customer groups, offers and coupons, email campaigns, blogs, reviews and analytics, all fed by one customer history.",
});

export default function MarketingPage() {
  return (
    <>
      <PageHero
        label="Customers & marketing"
        title={
          <>
            Turn first orders into <em>lasting relationships.</em>
          </>
        }
        lead="Groups, offers, email campaigns, blogs and reviews, all working from the same customer history, whether that customer bought online or across the counter."
        secondary={{ href: "/products/mink-ai", text: "Meet Mink AI" }}
      />

      <FeatureRows>
        <FeatureRow
          label="Offers"
          title="One engine for every discount."
          points={[
            "Automatic offers, discount codes and shareable links",
            "Buy X get Y, bundles, spend ladders and free delivery",
            "Budgets and redemption caps that hold under load",
            "The same offer at checkout and at the counter",
          ]}
          art={<GrowthArt />}
          tone="navy"
        >
          Describe the offer once and StoreMink applies it everywhere the
          customer can buy. The best offer wins, every rupee of discount is
          recorded on the line it applied to, and a refund undoes it exactly.
        </FeatureRow>
        <FeatureRow
          label="Customers"
          title="One customer list, every channel."
          points={[
            "Customer groups for wholesale pricing and targeted offers",
            "Walk-ins recorded at the counter join the same list",
            "Saved addresses, order history and store credit per customer",
            "Enquiries from the storefront in one inbox",
          ]}
          art={<ChannelsArt />}
          tone="grey"
        >
          A shopper who signs up online after buying in your shop is matched to
          their counter history by phone, so their store credit, orders and
          group follow them.
        </FeatureRow>
      </FeatureRows>

      <PillarGrid
        label="Grow"
        title="Reach people, then measure it."
        columns={4}
        pillars={[
          {
            icon: <Mail size={20} />,
            title: "Email campaigns",
            body: "Send a coupon to all customers or one group, with merge tags and AI-drafted copy, on the Pro plan.",
          },
          {
            icon: <Star size={20} />,
            title: "Reviews and blogs",
            body: "Product reviews, a blog with reactions and comments, and optional customer submissions you approve.",
          },
          {
            icon: <Users size={20} />,
            title: "Newsletter capture",
            body: "A consent-aware signup form in the footer and as a section, with the wording recorded alongside each subscriber.",
          },
          {
            icon: <BarChart3 size={20} />,
            title: "Analytics",
            body: "Sales, channels, locations, top products and Google Search performance. GA4, Meta Pixel and conversion funnels on Pro.",
          },
        ]}
      />

      <RelatedPages
        pages={PRODUCT_PAGES.filter((p) => p.path !== "/products/marketing")}
      />

      <CtaBand />
    </>
  );
}
