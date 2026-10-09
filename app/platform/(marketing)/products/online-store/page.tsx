import Image from "next/image";
import { THEMES_URL } from "@/lib/site";
import { PRODUCT_PAGES } from "../../../marketing-routes";
import { BuilderArt, StorefrontArt } from "../../../product-art";
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
  path: "/products/online-store",
  title: "Online store",
  description:
    "A storefront that feels like your brand: pick a theme, shape every page in the visual builder, publish on your own domain. No developer needed.",
});

export default function OnlineStorePage() {
  return (
    <>
      <PageHero
        label="Online store"
        title={
          <>
            A storefront that feels like <em>your brand.</em>
          </>
        }
        lead="Choose a theme, arrange ready-made sections, add your own domain and publish, without waiting on a developer. Your store is live on its own subdomain from day one."
        secondary={{ href: THEMES_URL, text: "Browse themes" }}
      >
        <div className="smm-hero-photo">
          <Image
            src="/marketing/scenes/builder-desk.webp"
            alt="A laptop and a phone on a desk, both showing an online store being built"
            width={1600}
            height={900}
            sizes="100vw"
            priority
          />
        </div>
      </PageHero>

      <FeatureRows>
        <FeatureRow
          label="Themes"
          title="Start from a look that already works."
          points={[
            "Distinct themes with their own type, colour and layout",
            "Header, product card, product page, cart and footer variants",
            "Your palette, fonts and corner radii on top of any theme",
            "A healthy demo store to preview before you choose",
          ]}
          link={{ href: THEMES_URL, text: "Browse themes", external: true }}
          art={<StorefrontArt />}
          tone="lilac"
        >
          Every theme is a complete store: pages, navigation, sample products
          and imagery. Pick one at signup, then make it yours. The look updates
          across every page at once.
        </FeatureRow>
        <div id="builder" />
        <FeatureRow
          label="Visual website builder"
          title="Make every page yours."
          points={[
            "Hero, carousel, featured products, galleries, testimonials, FAQs and more",
            "Click to edit on a live preview, with undo and autosave",
            "Draft until you publish, so nothing goes live half-finished",
            "Your own HTML, CSS and JavaScript on paid plans",
          ]}
          art={<BuilderArt />}
          tone="cream"
        >
          Seventeen section types, each with its own settings, arranged by
          dragging. The homepage, your content pages and your header and footer
          are all edited in the same place with the same preview.
        </FeatureRow>
      </FeatureRows>

      <PillarGrid
        label="Included"
        title="The parts of a store people forget until launch day."
        columns={4}
        pillars={[
          {
            title: "Your own domain",
            body: "Connect a domain you already own. StoreMink issues the certificate and keeps it renewed.",
          },
          {
            title: "Search-ready",
            body: "Clean URLs, product and collection pages, sitemaps and structured data, submitted to Google when you go live.",
          },
          {
            title: "Phone-first",
            body: "Swipeable galleries, a sticky add-to-cart bar and filters that work on a 390px screen.",
          },
          {
            title: "Product options",
            body: "Size, colour, pack: up to three option axes with swatches, photos per colour and per-variant stock.",
          },
        ]}
      />

      <RelatedPages
        pages={PRODUCT_PAGES.filter((p) => p.path !== "/products/online-store")}
      />

      <CtaBand />
    </>
  );
}
