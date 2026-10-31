import { CommerceCommandCentre, MinkArt } from "../../../homepage-art";
import { PRODUCT_PAGES } from "../../../marketing-routes";
import { BuilderArt } from "../../../product-art";
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
  path: "/products/mink-ai",
  title: "Mink AI",
  description:
    "Mink is StoreMink's built-in commerce AI: permission-aware answers from your own store data, private drafts you review before anything goes live, and credits included on every plan.",
});

export default function MinkAiPage() {
  return (
    <>
      <PageHero
        label="Mink AI · Beta"
        title={
          <>
            Meet your secret weapon, <em>Mink.</em>
          </>
        }
        lead="Your commerce AI, built into StoreMink. Get insights from your store data and review AI-generated drafts before publishing."
        secondary={{ href: "/pricing", text: "Credits on every plan" }}
      >
        <div className="smm-art is-navy">
          <MinkArt />
        </div>
      </PageHero>

      <FeatureRows>
        <FeatureRow
          label="Ask"
          title="Answers from your store, not the internet."
          points={[
            "Track sales, orders, stock and customers.",
            "Get accurate, role-based answers with masked customer details.",
            "Get Help Centre guidance and how-to answers.",
            "Automate weekly reports and background investigations.",
          ]}
          art={<CommerceCommandCentre />}
          tone="lilac"
        >
          Mink delivers real-time insights from your store data, based on your
          role and accessible locations.
        </FeatureRow>
        <FeatureRow
          label="Draft"
          title="Drafts you review. Nothing publishes itself."
          points={[
            "Product descriptions and SEO in your brand voice",
            "Blog posts, coupon emails and customer messages",
            "Storefront pages, layouts, colours and generated images",
            "Every draft is private until you approve it, and reversible after",
          ]}
          art={<BuilderArt />}
          tone="cream"
        >
          Upload a photo and tell Mink what you need. It prepares the changes
          for your review, while publishing stays in your hands.
        </FeatureRow>
      </FeatureRows>

      <PillarGrid
        label="Designed to be trusted"
        title="Built for a business, not a demo."
        lead="Mink can do real work in your store, so every action it prepares is checked the same way a staff member's would be."
        columns={3}
        pillars={[
          {
            title: "Permission-aware",
            body: "Mink only accesses what your role allows.",
          },
          {
            title: "Human approval",
            body: "You review and approve every change before it is applied.",
          },
          {
            title: "Private by default",
            body: "Your drafts stay private. Mink never publishes or sends anything on its own.",
          },
          {
            title: "Talk or type",
            body: "Type, speak, upload images or PDFs, or share a product CSV. Mink understands and asks when needed.",
          },
          {
            title: "Images that match your shop",
            body: "Create campaign images using your product photos. All designs are saved to your Media Library.",
          },
          {
            title: "Clear on cost",
            body: "Every plan includes monthly Mink credits. Costs depend on the task, and your balance is always visible.",
          },
        ]}
      />

      <RelatedPages
        pages={PRODUCT_PAGES.filter((p) => p.path !== "/products/mink-ai")}
      />

      <CtaBand
        title="Try Mink on your own store"
        lead="Mink credits are included on the Free plan. Create a store, add a product and ask your first question."
      />
    </>
  );
}
