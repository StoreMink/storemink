import {
  Eye,
  FileCheck,
  Image as ImageIcon,
  Lock,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
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
        dark
        title={
          <>
            Meet your secret weapon, <em>Mink.</em>
          </>
        }
        lead="Your very own commerce AI, built into the StoreMink dashboard. Ask about your store and get answers from your own data. Have Mink prepare drafts you review before anything goes live."
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
            "Sales, orders, low stock and customers by date, channel and location",
            "Only what your role is allowed to see; direct customer details are masked",
            "Help Centre answers for how-to questions",
            "Weekly trading reports and investigations that run in the background",
          ]}
          art={<CommerceCommandCentre />}
          tone="lilac"
        >
          Mink reads the same figures your dashboard shows, scoped to the
          locations you can see. Ask which products at a shop are below their
          reorder level and the answer is the shelf count, not a guess.
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
          Attach a photo and say what to do with it: create the product, put it
          on the homepage, write the launch email. Mink prepares the change and
          hands you one button to apply it. Publishing stays a separate step you
          take.
        </FeatureRow>
      </FeatureRows>

      <PillarGrid
        label="Designed to be trusted"
        title="Built for a business, not a demo."
        lead="Mink can do real work in your store, so every action it prepares is checked the same way a staff member's would be."
        columns={3}
        tone="white"
        pillars={[
          {
            icon: <ShieldCheck size={20} />,
            title: "Permission-aware",
            body: "Mink holds exactly the permissions of the person asking. A cashier's Mink cannot read what a cashier cannot.",
          },
          {
            icon: <FileCheck size={20} />,
            title: "Human approval",
            body: "A change is applied only when you approve it, and only if the record has not moved since Mink looked at it.",
          },
          {
            icon: <Lock size={20} />,
            title: "Private by default",
            body: "Drafts belong to the person who asked. Nothing is sent, published or charged to a customer by Mink itself.",
          },
          {
            icon: <MessageSquare size={20} />,
            title: "Talk or type",
            body: "Dictate a request, attach images or a PDF, or paste a product CSV. Mink reads it and asks when something is unclear.",
          },
          {
            icon: <ImageIcon size={20} />,
            title: "Images that match your shop",
            body: "Generated campaign art is grounded in your own product photos, saved to your Media Library and never pretends to be a product photo.",
          },
          {
            icon: <Eye size={20} />,
            title: "Clear on cost",
            body: "Every plan includes Mink credits each month. A simple question costs one; a bigger piece of work costs more, and the balance is always visible.",
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
