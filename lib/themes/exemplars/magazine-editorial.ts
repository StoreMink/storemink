// Magazine / editorial — "Folio & Form": a home-objects store that reads
// like a journal. Fraunces headings, a centered header, media stories in
// alternating beats, an editorial gallery, centered cards, the stacked
// product page and fade motion. Studio's imagery and catalogue.
import { DESIGN_FONTS } from "../fonts";
import { studio } from "../definitions/studio";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";

const ID = "exemplar-magazine-editorial";
const pic = (name: string) => img(ID, name);
const catalogue = catalogueOf(studio, ID);

export const magazineEditorial = exemplar(
  exemplarMeta({
    id: ID,
    name: "Folio & Form",
    description:
      "A magazine-style home-objects store: Fraunces headings, media stories told in beats, an editorial gallery and a stacked product page.",
    direction: "magazine-editorial",
    engine: "storefront-editorial",
    industries: ["home", "art"],
    catalogSizes: ["small", "medium"],
    features: [
      "blogs",
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["editorial", "magazine", "home", "objects", "journal"],
    previewImage: pic("preview"),
    screenshotAlt: "Folio & Form homepage with an editorial media story",
  }),
  "magazine-editorial",
  {
    brand: {
      primaryColor: "#2f4a3f",
      tagline: "Objects with a story, and the story",
      blurb:
        "A small home store in Goa that sells the chair and tells you who made it: seating, lighting, objects and textiles chosen one maker at a time and written up like a magazine.",
    },
    announcement: {
      text: "Issue 12 is out: the lamp-maker of Pondicherry, and free delivery on orders over ₹4,000",
      href: "/the-journal",
    },
    design: {
      palette: {
        cream: "#f7f4ee",
        creamDeep: "#ece7dd",
        surface: "#fffdf9",
        ink: "#221f1c",
        inkSoft: "#5f5952",
        inkFaint: "#9a9189",
        taupe: "#e3dcd0",
        sand: "#efe9df",
        butter: "#f1e4c7",
        border: "#dcd4c8",
        tile: "#efe9df",
        accentWarm: "#b86f4a",
        onAccent: "#ffffff",
        onInk: "#f7f4ee",
        shadowRgb: "34, 31, 28",
        success: "#2f6b4f",
        successSoft: "#e6f0ea",
        error: "#a8321f",
        errorSoft: "#f8e8e4",
        star: "#b86f4a",
        highlight: "#2f4a3f",
      },
      fonts: {
        body: DESIGN_FONTS.inter,
        display: DESIGN_FONTS.fraunces,
      },
      shape: { card: "2px", control: "2px", sm: "2px", pill: "999px" },
      layout: {
        header: "centered",
        card: "centered",
        productDetail: "stacked",
        cart: "compact",
        footer: "editorial",
        stickyAddToCart: false,
        gridColumnsMobile: 1,
        gridColumnsDesktop: 3,
        shopFilters: true,
        collectionBanner: false,
        cardHoverImage: true,
      },
      typography: {
        headingFont: "display",
        headingScale: "large",
        headingWeight: "medium",
        headingCase: "none",
        headingTracking: "normal",
      },
      buttons: {
        shape: "square",
        primary: "solid",
        secondary: "text",
        case: "none",
        weight: "medium",
        tracking: "normal",
        hover: "darken",
      },
      page: { width: "standard", sectionGap: "airy", gridGap: "roomy" },
      motion: { reveal: "fade" },
    },
    templates: {
      product: {
        gallery: "stacked",
        blocks: [
          { type: "price" },
          { type: "description" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "rich_text",
            html: "<p>Every object on this page was made by a person we have met. The maker's name is on the care card, and the price includes their margin, not ours alone.</p>",
          },
          {
            type: "accordion",
            rows: [
              {
                heading: "The maker",
                body: "Written up in the journal. Follow the link on the care card for the full story.",
              },
              {
                heading: "Delivery",
                body: "Furniture is delivered by our own van within Goa and by a white-glove carrier elsewhere, in two to three weeks. Objects post in a week.",
              },
            ],
          },
          { type: "share" },
          { type: "recommendations" },
        ],
      },
      collection: {
        filters: "drawer",
        pagination: "load-more",
        promoTiles: [
          {
            afterIndex: 3,
            heading: "From the journal",
            body: "The lamp-maker of Pondicherry, and the clay he will not sell.",
            cta_label: "Read issue 12",
            href: "/the-journal",
            image_url: "",
            image_alt: "",
            theme: "dark",
            background: "#ece7dd",
          },
        ],
      },
      blog: { index: "featured", article: "sidebar" },
      account: { layout: "sidebar", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Seating, lighting, objects and textiles chosen one maker at a time, with the maker's story alongside.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Issue 12: the lamp-maker",
                  subheading:
                    "A terracotta lamp, a kiln on the beach, and the one glaze he keeps for himself.",
                  cta_label: "Read the story",
                  cta_href: "/the-journal",
                  image_url: pic("hero"),
                  video_url: "",
                  background: "#ece7dd",
                  theme: "light",
                  overlay_opacity: 30,
                  content_position: "bottom",
                },
                {
                  heading: "Seating, slowly",
                  subheading:
                    "Chairs that take a month to make and a lifetime to sit in.",
                  cta_label: "Shop seating",
                  cta_href: "/collections/seating",
                  image_url: pic("chair"),
                  video_url: "",
                  background: "#ece7dd",
                  theme: "light",
                  overlay_opacity: 30,
                  content_position: "bottom",
                },
              ],
              height: "large",
              autoplay: true,
              interval_seconds: 8,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "story",
            "media_text",
            {
              eyebrow: "Issue 12",
              heading: "The lamp-maker of Pondicherry",
              body: "He throws forty bases a morning and keeps one in ten. The glaze is a family recipe he will describe but not write down. We bought the whole summer's run.",
              cta_label: "Shop the lamps",
              cta_href: "/collections/lighting",
              image_url: pic("lamp"),
              image_alt: "A terracotta table lamp with a linen shade",
              media_position: "right",
              media_ratio: "landscape",
              alignment: "left",
              stories: [
                {
                  eyebrow: "Issue 11",
                  heading: "The weaver with the grid",
                  body: "A wool throw woven on a loom her grandmother set up, in a grid she has not changed in thirty years.",
                  cta_label: "Shop textiles",
                  cta_href: "/collections/textiles-art",
                  image_url: pic("throw"),
                  image_alt: "A grid-patterned wool throw folded over a chair",
                  media_position: "left",
                },
                {
                  eyebrow: "Issue 10",
                  heading: "Bookends from a quarry",
                  body: "Offcuts from a Rajasthan quarry, ground to a curve by hand. No two pairs match, which is the point.",
                  cta_label: "Shop objects",
                  cta_href: "/collections/objects",
                  image_url: pic("bookends"),
                  image_alt: "A pair of curved stone bookends",
                  media_position: "right",
                },
              ],
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "lookbook",
            "gallery",
            {
              heading: "In the room",
              subheading: "Objects photographed where they live",
              items: [
                {
                  image_url: pic("vase"),
                  image_alt: "A stoneware vase on a windowsill",
                  caption: "Field vase",
                  href: "/shop/field-stoneware-vase",
                },
                {
                  image_url: pic("side-table"),
                  image_alt: "An arched side table beside an armchair",
                  caption: "Arc side table",
                  href: "/shop/arc-side-table",
                },
                {
                  image_url: pic("serving-bowl"),
                  image_alt: "A wide serving bowl on a wooden table",
                  caption: "Mesa bowl",
                  href: "/shop/mesa-serving-bowl",
                },
                {
                  image_url: pic("art-print"),
                  image_alt: "A framed abstract print leaning on a wall",
                  caption: "Form No. 03",
                  href: "/shop/form-no-03-art-print",
                },
              ],
              layout: "editorial",
              columns: 3,
              image_ratio: "landscape",
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "edit",
            "featured_products",
            {
              heading: "The current edit",
              subheading: "",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 6,
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "readers",
            "testimonials",
            {
              eyebrow: "Readers",
              heading: "Letters to the editor",
              subheading: "",
              items: [
                {
                  quote:
                    "I bought the chair for the story and kept it for the chair. Both were true.",
                  author: "Nandita K.",
                  detail: "Pune",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote: "The only shop whose emails I read to the end.",
                  author: "Tom R.",
                  detail: "Goa",
                  logo_url: "",
                  logo_alt: "",
                },
              ],
              layout: "editorial",
              columns: 2,
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "subscribe",
            "newsletter",
            {
              eyebrow: "The journal",
              heading: "One issue a month",
              subheading:
                "A maker, their work, and what we bought from them. No offers, no countdowns.",
              button_label: "Subscribe",
              success_message: "Thank you. Issue 13 is on its way.",
              consent_text:
                "I agree to receive the Folio & Form journal by email.",
              theme: "dark",
              alignment: "left",
            },
            { padding_y: "lg", width: "contained" },
          ),
        ],
      },
      {
        slug: "the-journal",
        title: "The Journal",
        seo_description:
          "Folio & Form's journal: one maker a month, their work and what we bought from them, starting with the lamp-maker of Pondicherry.",
        sections: [
          section("journal-lead", "media_text", {
            eyebrow: "Issue 12",
            heading: "A kiln on the beach",
            body: "The kiln is a brick drum behind a house on the Pondicherry shore, and it fires once a week when the wind is right. We spent two days there and came home with the summer's lamps.",
            cta_label: "Shop the lamps",
            cta_href: "/collections/lighting",
            image_url: pic("lamp"),
            image_alt: "A terracotta lamp base beside its linen shade",
            media_position: "left",
            media_ratio: "square",
            alignment: "left",
          }),
          section(
            "journal-room",
            "before_after",
            {
              eyebrow: "One corner, twice",
              heading: "Before and after the lamp",
              subheading:
                "Drag across to see what one light does to a reading corner.",
              before: {
                image_url: pic("chair"),
                image_alt: "A reading corner with a lounge chair and no lamp",
                label: "Before",
              },
              after: {
                image_url: pic("hero"),
                image_alt: "The same corner lit by a terracotta table lamp",
                label: "After",
              },
              image_ratio: "landscape",
              start: 50,
            },
            { padding_y: "md", width: "contained" },
          ),
          section("journal-text", "rich_text", {
            html: "<h2>Why we write it up</h2><p>A chair is a chair until you know who made it. The journal exists so that the price on the tag means something: a month of someone's work, a glaze they guard, a loom their grandmother set up. We publish one issue a month and we sell what we write about, which is the only conflict of interest we have.</p>",
            width: "contained",
          }),
        ],
      },
    ],
    menus: {
      header: [
        {
          label: "Shop",
          href: "/shop",
          image_url: pic("chair"),
          children: [
            {
              label: "Rooms",
              href: "",
              children: [
                { label: "Seating", href: "/collections/seating" },
                { label: "Lighting", href: "/collections/lighting" },
              ],
            },
            {
              label: "Smaller things",
              href: "",
              children: [
                { label: "Objects", href: "/collections/objects" },
                {
                  label: "Textiles and art",
                  href: "/collections/textiles-art",
                },
              ],
            },
          ],
        },
        { label: "The journal", href: "/the-journal" },
        { label: "Blog", href: "/blogs" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Seating", href: "/collections/seating" },
            { label: "Lighting", href: "/collections/lighting" },
          ],
        },
        {
          title: "Read",
          links: [
            { label: "The journal", href: "/the-journal" },
            { label: "Blog", href: "/blogs" },
          ],
        },
        {
          title: "Help",
          links: [
            { label: "Enquiries", href: "/enquiries" },
            { label: "Shipping policy", href: "/shipping-policy" },
          ],
        },
      ],
      footerLegal: [
        { label: "Privacy", href: "/privacy-policy" },
        { label: "Terms", href: "/terms" },
      ],
    },
    sampleData: catalogue,
  },
);
