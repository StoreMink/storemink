// Bold and loud — "VOLT": a streetwear and footwear label. A dark page, a
// lime accent, poster type, a transparent header over a three-slide
// opening, a collage tile grid, overlay cards and rise motion. Vitrine's
// imagery and catalogue.
import { DESIGN_FONTS } from "../fonts";
import { vitrine } from "../definitions/vitrine";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";
import { EXEMPLAR_STYLESHEETS } from "./stylesheets";

const ID = "exemplar-bold-and-loud";
const pic = (name: string) => img(ID, name);
const catalogue = catalogueOf(vitrine, ID);

export const boldAndLoud = exemplar(
  exemplarMeta({
    id: ID,
    name: "VOLT",
    description:
      "A bold streetwear and footwear label on a dark page: lime accent, poster type, a transparent header over the opening and a collage of drops.",
    direction: "bold-and-loud",
    engine: "storefront-editorial",
    industries: ["shoes", "clothing", "sports"],
    catalogSizes: ["small", "medium"],
    features: [
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["streetwear", "sneakers", "drop", "bold", "dark"],
    previewImage: pic("preview"),
    screenshotAlt: "VOLT homepage opening on a dark page with lime type",
  }),
  "bold-and-loud",
  {
    brand: {
      primaryColor: "#e8ff3a",
      tagline: "Loud shoes for quiet streets",
      blurb:
        "Limited runs of sneakers, boots and bags from a Delhi label that drops twice a season and never restocks: when a pair is gone, it is gone.",
    },
    announcement: {
      text: "Drop 09 lands Friday at 8 pm. Sign in to get the link first.",
      href: "/the-drop",
    },
    design: {
      palette: {
        cream: "#121212",
        creamDeep: "#1b1b1b",
        surface: "#1a1a1a",
        ink: "#f5f5f5",
        inkSoft: "#c9c9c9",
        inkFaint: "#8a8a8a",
        taupe: "#2a2a2a",
        sand: "#222222",
        butter: "#2e2a1f",
        border: "#343434",
        tile: "#1f1f1f",
        accentWarm: "#e8ff3a",
        onAccent: "#121212",
        onInk: "#121212",
        shadowRgb: "0, 0, 0",
        success: "#7ddc8a",
        successSoft: "#1d2a1f",
        error: "#ff6b6b",
        errorSoft: "#2a1c1c",
        star: "#e8ff3a",
        highlight: "#e8ff3a",
        accent: "#e8ff3a",
      },
      fonts: {
        body: DESIGN_FONTS.workSans,
        display: DESIGN_FONTS.bebasNeue,
      },
      shape: { card: "0px", control: "0px", sm: "0px", pill: "0px" },
      layout: {
        header: "transparent",
        card: "overlay",
        productDetail: "classic",
        cart: "classic",
        footer: "compact",
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 4,
        shopFilters: true,
        collectionBanner: true,
        cardHoverImage: true,
      },
      typography: {
        headingFont: "display",
        headingScale: "xlarge",
        headingWeight: "regular",
        headingCase: "uppercase",
        headingTracking: "tight",
      },
      buttons: {
        shape: "square",
        primary: "solid",
        secondary: "solid",
        case: "uppercase",
        weight: "bold",
        tracking: "wide",
        hover: "lift",
      },
      page: { width: "wide", sectionGap: "compact", gridGap: "tight" },
      motion: { reveal: "rise" },
    },
    templates: {
      product: {
        gallery: "grid",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "trust_row",
            items: [
              { icon: "truck", label: "Ships in 48 hours" },
              { icon: "refresh", label: "Seven-day exchange" },
              { icon: "lock", label: "Secure checkout" },
            ],
          },
          { type: "description" },
          {
            type: "size_guide",
            columns: ["UK", "EU", "US", "Foot length (cm)"],
            sizes: [
              { label: "6", values: ["6", "39", "7", "24.5"] },
              { label: "7", values: ["7", "40.5", "8", "25.5"] },
              { label: "8", values: ["8", "42", "9", "26.5"] },
              { label: "9", values: ["9", "43", "10", "27.5"] },
              { label: "10", values: ["10", "44.5", "11", "28.5"] },
            ],
          },
          { type: "share" },
          { type: "reviews" },
          { type: "recommendations" },
          { type: "sticky_bar" },
        ],
      },
      collection: {
        filters: "top-bar",
        pagination: "infinite",
        promoTiles: [
          {
            afterIndex: 4,
            heading: "Drop 09",
            body: "Friday, 8 pm. Forty pairs, then nothing.",
            cta_label: "Set a reminder",
            href: "/the-drop",
            image_url: "",
            image_alt: "",
            // Light copy is the on-ink, which on this dark palette is the
            // near-black that reads on the acid field; "dark" would be the
            // (light) ink.
            theme: "light",
            background: "#e8ff3a",
          },
        ],
      },
      blog: { index: "grid", article: "wide" },
      account: { layout: "tabs", scheme: "soft" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Limited runs of sneakers, boots and bags from a Delhi label that drops twice a season and never restocks.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Drop 09",
                  subheading: "Forty pairs. Friday. Then nothing.",
                  cta_label: "See the drop",
                  cta_href: "/the-drop",
                  image_url: pic("hero"),
                  video_url: "",
                  background: "#121212",
                  theme: "light",
                  overlay_opacity: 35,
                  content_position: "bottom",
                },
                {
                  heading: "The low-top",
                  subheading: "White leather, cupsole, no logo.",
                  cta_label: "Shop sneakers",
                  cta_href: "/collections/mens-shoes",
                  image_url: pic("sneaker"),
                  video_url: "",
                  background: "#121212",
                  theme: "light",
                  overlay_opacity: 30,
                  content_position: "bottom",
                },
                {
                  heading: "The boot",
                  subheading: "Black leather, lugged, built for the monsoon.",
                  cta_label: "Shop boots",
                  cta_href: "/collections/womens-shoes",
                  image_url: pic("boot"),
                  video_url: "",
                  background: "#121212",
                  theme: "light",
                  overlay_opacity: 30,
                  content_position: "bottom",
                },
              ],
              height: "screen",
              autoplay: true,
              interval_seconds: 5,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "wire",
            "ticker",
            {
              messages: [
                "Drop 09 lands Friday 8 pm",
                "Forty pairs per style",
                "No restocks, ever",
                "Free exchanges within seven days",
              ],
              speed: "fast",
              theme: "dark",
            },
            { scheme: "accent", padding_y: "sm", width: "full" },
          ),
          section(
            "drops",
            "tile_grid",
            {
              heading: "The drops",
              subheading: "",
              tiles: [
                {
                  title: "Sneakers",
                  subtitle: "Low-tops and cupsoles",
                  href: "/collections/mens-shoes",
                  image_url: pic("sneaker"),
                  background: "",
                  theme: "light",
                  span: "2x2",
                },
                {
                  title: "Boots",
                  subtitle: "Lugged and lined",
                  href: "/collections/womens-shoes",
                  image_url: pic("boot"),
                  background: "",
                  theme: "light",
                  span: "1x2",
                },
                {
                  title: "Bags",
                  subtitle: "Totes and crossbodies",
                  href: "/collections/handbags",
                  image_url: pic("crossbody"),
                  background: "",
                  theme: "light",
                },
                {
                  title: "Eyewear",
                  subtitle: "Acetate frames",
                  href: "/collections/accessories",
                  image_url: pic("sunglasses"),
                  background: "",
                  theme: "light",
                },
                {
                  title: "Belts",
                  subtitle: "Full-grain, brass",
                  href: "/collections/accessories",
                  image_url: pic("belt"),
                  background: "",
                  theme: "light",
                  span: "2x1",
                },
              ],
              columns: 4,
              height: "md",
              layout: "collage",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "now",
            "featured_products",
            {
              heading: "On the shelf now",
              subheading: "What is left of Drop 08",
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
              eyebrow: "Pair of the week",
              heading: "",
              body: "Cut from one hide, lasted on a cupsole we tooled ourselves, and made in a run of forty. The pair people stop you about.",
              source: "featured",
              product_id: null,
              media_position: "right",
              cta_label: "Get the pair",
              show_price: true,
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "which",
            "comparison",
            {
              heading: "Which pair",
              subheading: "Three shapes, one answer each",
              columns: [
                {
                  label: "Low-top",
                  caption: "Every day",
                  cta_label: "Shop low-tops",
                  cta_href: "/collections/mens-shoes",
                  highlight: true,
                },
                {
                  label: "Boot",
                  caption: "Rain and rough ground",
                  cta_label: "Shop boots",
                  cta_href: "/collections/womens-shoes",
                  highlight: false,
                },
                {
                  label: "Loafer",
                  caption: "Dinner",
                  cta_label: "Shop loafers",
                  cta_href: "/collections/mens-shoes",
                  highlight: false,
                },
              ],
              rows: [
                {
                  type: "text",
                  label: "Sole",
                  values: [
                    "Rubber cupsole",
                    "Lugged rubber",
                    "Leather, welted",
                  ],
                },
                {
                  type: "check",
                  label: "Waterproof",
                  values: ["no", "yes", "no"],
                },
                {
                  type: "check",
                  label: "Resoleable",
                  values: ["no", "yes", "yes"],
                },
                {
                  type: "text",
                  label: "Break-in",
                  values: ["None", "Two weeks", "A week"],
                },
              ],
              style: "cards",
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "list",
            "newsletter",
            {
              eyebrow: "The list",
              heading: "Get the link before the drop goes public",
              subheading:
                "One message per drop, an hour before anyone else. Nothing in between.",
              button_label: "Join the list",
              success_message: "You are on it. Watch for the link.",
              consent_text:
                "I agree to receive drop alerts from VOLT by email.",
              theme: "light",
              alignment: "left",
            },
            { scheme: "accent", padding_y: "lg", width: "full" },
          ),
        ],
      },
      {
        slug: "the-drop",
        title: "The Drop",
        seo_description:
          "How VOLT drops work: forty pairs per style, twice a season, no restocks, and the list that gets the link an hour early.",
        sections: [
          section(
            "drop-hero",
            "hero",
            {
              variant: "stacked",
              height: "large",
              heading: "Drop 09",
              subheading:
                "Four styles, forty pairs each, Friday at 8 pm. When a pair is gone it is gone; we do not restock a drop, ever.",
              cta_label: "Shop what is left of 08",
              cta_href: "/shop",
              image_url: pic("hero"),
              video_url: "",
              badge_text: "Friday 8 pm",
              background: "#1b1b1b",
              // On this dark palette "dark" is the (light) ink: the readable
              // choice over the near-black field (lib/themes/hero-contrast.ts).
              theme: "dark",
              alignment: "left",
            },
            { width: "full", padding_y: "none" },
          ),
          section("drop-gallery", "gallery", {
            heading: "In the drop",
            subheading: "",
            items: [
              {
                image_url: pic("sneaker"),
                image_alt: "A white leather low-top sneaker",
                caption: "Low-top, bone",
                href: "/shop/aveny-low-top-sneaker",
              },
              {
                image_url: pic("boot"),
                image_alt: "A black lugged ankle boot",
                caption: "Boot, black",
                href: "/shop/rowan-ankle-boot",
              },
              {
                image_url: pic("loafer"),
                image_alt: "A brown penny loafer",
                caption: "Loafer, tan",
                href: "/shop/marlowe-leather-loafer",
              },
              {
                image_url: pic("tote"),
                image_alt: "A black structured tote bag",
                caption: "Tote, black",
                href: "/shop/astrid-structured-tote",
              },
            ],
            layout: "editorial",
            columns: 3,
            image_ratio: "square",
          }),
          section("drop-faq", "faq_accordion", {
            heading: "How a drop works",
            subheading: "",
            items: [
              {
                question: "Will you restock?",
                answer:
                  "No. Every drop is forty pairs per style and the mould is retired after. The next drop is a new shape.",
                category: "",
              },
              {
                question: "Can I exchange a size?",
                answer:
                  "Within seven days, while the size is still in stock. We hold two pairs per size back for exactly this.",
                category: "",
              },
              {
                question: "How early does the list get the link?",
                answer:
                  "One hour. The link goes to the list at 7 pm and to the homepage at 8.",
                category: "",
              },
            ],
            show_filters: false,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop" },
        { label: "Sneakers", href: "/collections/mens-shoes" },
        { label: "Boots", href: "/collections/womens-shoes" },
        { label: "Bags", href: "/collections/handbags" },
        { label: "The drop", href: "/the-drop" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "The drop", href: "/the-drop" },
          ],
        },
        {
          title: "Help",
          links: [
            { label: "Enquiries", href: "/enquiries" },
            { label: "Refund policy", href: "/refund-policy" },
          ],
        },
      ],
      footerLegal: [
        { label: "Privacy", href: "/privacy-policy" },
        { label: "Terms", href: "/terms" },
      ],
    },
    // The theme's own style rules (./stylesheets.ts, plan Phase 3).
    stylesheet: EXEMPLAR_STYLESHEETS["bold-and-loud"],
    sampleData: catalogue,
  },
);
