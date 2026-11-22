// Classic and trusted — "Northfield & Co.": a home-furnishing retailer.
// A utility header (delivery, search, account and cart above the brand
// row), a clear trust bar, wide cards, a delivery comparison table, a
// product spotlight, testimonials and an image-led collection banner.
// Studio's imagery and catalogue.
import { DESIGN_FONTS } from "../fonts";
import { studio } from "../definitions/studio";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";
import { EXEMPLAR_STYLESHEETS } from "./stylesheets";

const ID = "exemplar-classic-and-trusted";
const pic = (name: string) => img(ID, name);
const catalogue = catalogueOf(studio, ID);

export const classicAndTrusted = exemplar(
  exemplarMeta({
    id: ID,
    name: "Northfield & Co.",
    description:
      "A classic, trusted home-furnishing store: a utility header, a clear trust bar, wide cards, a delivery comparison and customer reviews.",
    direction: "classic-and-trusted",
    engine: "storefront-editorial",
    industries: ["home", "general"],
    catalogSizes: ["medium", "large"],
    features: [
      "advanced-search",
      "cart-drawer",
      "category-navigation",
      "faq",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["furniture", "home", "trusted", "delivery", "classic"],
    previewImage: pic("preview"),
    screenshotAlt: "Northfield & Co. homepage with the utility header",
  }),
  "classic-and-trusted",
  {
    brand: {
      primaryColor: "#1d4ed8",
      tagline: "Furniture you can see before you buy",
      blurb:
        "Seating, lighting and objects from a Bengaluru showroom that has delivered its own furniture for twenty-two years: assembled in your room, the packaging taken away, and a ten-year guarantee on every frame.",
    },
    announcement: {
      text: "White-glove delivery across Bengaluru, assembled in your room",
      href: "/delivery",
    },
    design: {
      palette: {
        cream: "#ffffff",
        creamDeep: "#f3f4f6",
        surface: "#ffffff",
        ink: "#1f2937",
        inkSoft: "#4b5563",
        inkFaint: "#9ca3af",
        taupe: "#e5e7eb",
        sand: "#f3f4f6",
        butter: "#fef3c7",
        border: "#e5e7eb",
        tile: "#f3f4f6",
        accentWarm: "#b45309",
        onAccent: "#ffffff",
        onInk: "#ffffff",
        shadowRgb: "31, 41, 55",
        success: "#15803d",
        successSoft: "#dcfce7",
        error: "#b91c1c",
        errorSoft: "#fee2e2",
        star: "#d97706",
        highlight: "#1d4ed8",
        accent: "#1d4ed8",
      },
      fonts: {
        body: DESIGN_FONTS.inter,
        display: DESIGN_FONTS.jakarta,
      },
      shape: { card: "8px", control: "6px", sm: "4px", pill: "999px" },
      layout: {
        header: "utility",
        card: "wide",
        productDetail: "classic",
        cart: "classic",
        footer: "rich",
        stickyAddToCart: true,
        gridColumnsMobile: 1,
        gridColumnsDesktop: 4,
        shopFilters: true,
        collectionBanner: true,
      },
      typography: {
        headingFont: "display",
        headingScale: "medium",
        headingWeight: "semibold",
        headingCase: "none",
        headingTracking: "normal",
      },
      buttons: {
        shape: "rounded",
        primary: "solid",
        secondary: "outline",
        case: "none",
        weight: "semibold",
        tracking: "normal",
        hover: "darken",
      },
      page: { width: "standard", sectionGap: "standard", gridGap: "standard" },
      motion: { reveal: "none" },
    },
    templates: {
      product: {
        gallery: "thumbs-bottom",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          { type: "delivery_estimate" },
          {
            type: "trust_row",
            items: [
              { icon: "truck", label: "White-glove delivery" },
              { icon: "shield", label: "Ten-year frame guarantee" },
              { icon: "refresh", label: "Thirty-day returns" },
              { icon: "headphones", label: "Showroom on the phone" },
            ],
          },
          { type: "description" },
          {
            type: "accordion",
            rows: [
              {
                heading: "Dimensions and materials",
                body: "Full dimensions, weight and materials are listed on the specification sheet, downloadable from this page.",
              },
              {
                heading: "Delivery and assembly",
                body: "Delivered by our own team within Bengaluru in five to ten days, assembled in the room of your choice, packaging removed.",
              },
              {
                heading: "Guarantee",
                body: "Ten years on every frame and five on upholstery, honoured in the showroom with no receipt needed.",
              },
            ],
          },
          { type: "share" },
          { type: "reviews" },
          { type: "recommendations" },
          { type: "sticky_bar" },
        ],
      },
      collection: {
        filters: "sidebar",
        pagination: "paged",
        promoTiles: [
          {
            afterIndex: 8,
            heading: "Visit the showroom",
            body: "Sit in it first. Open seven days on Residency Road.",
            cta_label: "Plan a visit",
            href: "/delivery",
            image_url: "",
            image_alt: "",
            theme: "dark",
            background: "#f3f4f6",
          },
        ],
      },
      blog: { index: "list", article: "wide" },
      account: { layout: "sidebar", scheme: "soft" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Seating, lighting and objects from a Bengaluru showroom with its own white-glove delivery and a ten-year guarantee.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Furniture you can see before you buy",
                  subheading:
                    "Sit in it in the showroom, or let us bring it and build it in your room.",
                  cta_label: "Shop seating",
                  cta_href: "/collections/seating",
                  image_url: pic("hero"),
                  video_url: "",
                  background: "#f3f4f6",
                  theme: "light",
                  overlay_opacity: 35,
                },
                {
                  heading: "Light for every corner",
                  subheading:
                    "Table, floor and pendant lamps, fitted by the team that delivers them.",
                  cta_label: "Shop lighting",
                  cta_href: "/collections/lighting",
                  image_url: pic("lamp"),
                  video_url: "",
                  background: "#f3f4f6",
                  theme: "light",
                  overlay_opacity: 35,
                },
              ],
              height: "large",
              autoplay: true,
              interval_seconds: 7,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "promises",
            "usp_bar",
            {
              theme: "dark",
              items: [
                {
                  icon: "truck",
                  title: "White-glove delivery",
                  subtitle: "Assembled in your room",
                },
                {
                  icon: "shield",
                  title: "Ten-year guarantee",
                  subtitle: "On every frame",
                },
                {
                  icon: "refresh",
                  title: "Thirty-day returns",
                  subtitle: "Collected from your door",
                },
                {
                  icon: "headphones",
                  title: "Showroom on the phone",
                  subtitle: "Seven days a week",
                },
              ],
            },
            { scheme: "soft", padding_y: "sm", width: "full" },
          ),
          section(
            "rooms",
            "shop_by_category",
            {
              heading: "Shop by room",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "grid",
              display: "cards",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "bestsellers",
            "featured_products",
            {
              heading: "Best sellers",
              subheading: "What leaves the showroom most",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 8,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "spot",
            "product_spotlight",
            {
              eyebrow: "Piece of the month",
              heading: "",
              body: "The chair our showroom staff sit in at lunch, which is the only review that matters. A dense weave, sprung seat and solid walnut feet.",
              source: "featured",
              product_id: null,
              media_position: "left",
              cta_label: "See the chair",
              show_price: true,
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "delivery",
            "comparison",
            {
              heading: "Choose your delivery",
              subheading: "Three ways to get it home",
              columns: [
                {
                  label: "Collect",
                  caption: "From the showroom",
                  cta_label: "Plan a visit",
                  cta_href: "/delivery",
                  highlight: false,
                },
                {
                  label: "Standard",
                  caption: "To your door",
                  cta_label: "See the details",
                  cta_href: "/delivery",
                  highlight: false,
                },
                {
                  label: "White glove",
                  caption: "Assembled in your room",
                  cta_label: "See the details",
                  cta_href: "/delivery",
                  highlight: true,
                },
              ],
              rows: [
                {
                  type: "text",
                  label: "Cost",
                  values: ["Free", "₹499", "₹1,499"],
                },
                {
                  type: "text",
                  label: "Time",
                  values: [
                    "Same day",
                    "Three to five days",
                    "Five to ten days",
                  ],
                },
                {
                  type: "check",
                  label: "Assembled for you",
                  values: ["no", "no", "yes"],
                },
                {
                  type: "check",
                  label: "Packaging taken away",
                  values: ["", "no", "yes"],
                },
                {
                  type: "check",
                  label: "Placed in the room",
                  values: ["no", "no", "yes"],
                },
              ],
              style: "table",
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "reviews",
            "testimonials",
            {
              eyebrow: "Customers",
              heading: "What people say",
              subheading: "",
              items: [
                {
                  quote:
                    "They carried the chair up four floors, built it in the living room and took the box away. I did not lift a finger.",
                  author: "Priya V.",
                  detail: "Indiranagar",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote:
                    "I rang about a wobble three years in. They came the next week and fixed it under the guarantee, no paperwork.",
                  author: "Suresh N.",
                  detail: "Jayanagar",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote:
                    "Sat in six chairs in the showroom before choosing. That is why I buy here.",
                  author: "Hannah D.",
                  detail: "Whitefield",
                  logo_url: "",
                  logo_alt: "",
                },
              ],
              layout: "cards",
              columns: 3,
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "questions",
            "faq_accordion",
            {
              heading: "Common questions",
              subheading: "",
              items: [
                {
                  question: "Do you deliver outside Bengaluru?",
                  answer:
                    "Yes, by carrier to most of South India in ten to fourteen days. Assembly is available in Chennai and Hyderabad.",
                  category: "Delivery",
                },
                {
                  question: "What does the guarantee cover?",
                  answer:
                    "Frames for ten years and upholstery for five, against defects in materials and making. It does not cover damage from misuse or sun fading.",
                  category: "Guarantee",
                },
                {
                  question: "Can I return something I have used?",
                  answer:
                    "Within thirty days, in the condition it arrived. We collect it, and the refund reaches you within a week.",
                  category: "Returns",
                },
              ],
              show_filters: true,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "signup",
            "newsletter",
            {
              eyebrow: "",
              heading: "New arrivals and showroom events",
              subheading:
                "One email a month. Sale previews go to subscribers a day early.",
              button_label: "Subscribe",
              success_message: "Thank you. You will hear from us next month.",
              consent_text:
                "I agree to receive emails from Northfield & Co. about new arrivals and events.",
              theme: "light",
              alignment: "center",
            },
            { scheme: "inverse", padding_y: "lg", width: "full" },
          ),
        ],
      },
      {
        slug: "delivery",
        title: "Delivery and the Showroom",
        seo_description:
          "Northfield & Co. delivery options across Bengaluru and South India, the white-glove service, and showroom hours on Residency Road.",
        sections: [
          section("delivery-cols", "multicolumn", {
            eyebrow: "Delivery",
            heading: "Three ways to get it home",
            subheading: "",
            items: [
              {
                icon: "",
                image_url: pic("hero"),
                image_alt:
                  "The Northfield showroom floor with chairs and lamps",
                heading: "Collect from the showroom",
                body: "Residency Road, seven days a week, eleven to eight. Free, and you can sit in it first.",
                cta_label: "",
                cta_href: "",
              },
              {
                icon: "",
                image_url: pic("side-table"),
                image_alt: "A side table boxed for delivery",
                heading: "Standard delivery",
                body: "To your door in three to five days across Bengaluru, ten to fourteen across South India.",
                cta_label: "",
                cta_href: "",
              },
              {
                icon: "",
                image_url: pic("chair"),
                image_alt: "A lounge chair assembled in a living room",
                heading: "White glove",
                body: "Our own team brings it, builds it in the room you choose and takes the packaging away.",
                cta_label: "Shop seating",
                cta_href: "/collections/seating",
              },
            ],
            columns: 3,
            alignment: "left",
            image_ratio: "landscape",
          }),
          section("delivery-text", "rich_text", {
            html: "<h2>The showroom</h2><p>Two floors on Residency Road, open seven days from eleven to eight. Every chair on the site is on the floor, and the team who deliver and assemble work from the same building, so the person who built your sofa is the one who will come back if it ever needs attention.</p>",
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
          children: [
            {
              label: "Furniture",
              href: "",
              children: [
                { label: "Seating", href: "/collections/seating" },
                { label: "Lighting", href: "/collections/lighting" },
              ],
            },
            {
              label: "Finishing",
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
        { label: "Delivery", href: "/delivery" },
        { label: "Enquiries", href: "/enquiries" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "All furniture", href: "/shop" },
            { label: "Seating", href: "/collections/seating" },
            { label: "Lighting", href: "/collections/lighting" },
            { label: "Objects", href: "/collections/objects" },
          ],
        },
        {
          title: "Customer care",
          links: [
            { label: "Delivery and the showroom", href: "/delivery" },
            { label: "Enquiries", href: "/enquiries" },
            { label: "Refund policy", href: "/refund-policy" },
            { label: "Shipping policy", href: "/shipping-policy" },
          ],
        },
      ],
      footerLegal: [
        { label: "Privacy", href: "/privacy-policy" },
        { label: "Terms", href: "/terms" },
      ],
    },
    // The theme's own style rules (./stylesheets.ts, plan Phase 3).
    stylesheet: EXEMPLAR_STYLESHEETS["classic-and-trusted"],
    sampleData: catalogue,
  },
);
