// Dense catalogue — "Rahi Daily Mart": a neighbourhood grocer online. A
// market header with a persistent search box, the category list with
// descriptions, quick-add cards in five desktop columns, compact spacing,
// sidebar filters, infinite paging and no motion. Basket's imagery and
// catalogue.
import { DESIGN_FONTS } from "../fonts";
import { basket } from "../definitions/basket";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";
import { EXEMPLAR_STYLESHEETS } from "./stylesheets";

const ID = "exemplar-dense-catalogue";
const pic = (name: string) => img(ID, name);
const catalogue = catalogueOf(basket, ID);

export const denseCatalogue = exemplar(
  exemplarMeta({
    id: ID,
    name: "Rahi Daily Mart",
    description:
      "A dense grocery catalogue: a market header with persistent search, a category list with descriptions, quick-add cards in five columns and sidebar filters.",
    direction: "dense-catalogue",
    engine: "storefront-editorial",
    industries: ["food-and-drink", "wholesale"],
    catalogSizes: ["medium", "large"],
    features: [
      "advanced-search",
      "cart-drawer",
      "category-navigation",
      "faq",
      "product-filtering",
      "product-recommendations",
      "promo-tiles",
      "quick-add",
      "variant-picker",
    ],
    keywords: ["grocery", "daily", "mart", "dense", "quick add"],
    previewImage: pic("preview"),
    screenshotAlt: "Rahi Daily Mart homepage with the category list",
  }),
  "dense-catalogue",
  {
    brand: {
      primaryColor: "#0f6a3c",
      tagline: "Everything the kitchen needs, by this evening",
      blurb:
        "A neighbourhood grocer online: produce picked at dawn, staples by the kilo, dairy from two farms we name, and same-day delivery across the city for orders placed by 6 pm.",
    },
    announcement: {
      text: "Order by 6 pm for same-day delivery across the city",
      href: "/delivery-and-returns",
    },
    design: {
      palette: {
        cream: "#ffffff",
        creamDeep: "#f2f5f2",
        surface: "#ffffff",
        ink: "#1e2b28",
        inkSoft: "#4f5d59",
        inkFaint: "#9aa8a2",
        taupe: "#eef3ee",
        sand: "#eef3ee",
        butter: "#fdf3d8",
        border: "#dfe6e1",
        tile: "#f6f8f6",
        accentWarm: "#ef5a2a",
        onAccent: "#ffffff",
        onInk: "#ffffff",
        shadowRgb: "16, 43, 36",
        success: "#2e7d32",
        successSoft: "#e8f5e9",
        error: "#c0392b",
        errorSoft: "#fdeeec",
        star: "#f2a900",
        highlight: "#ef5a2a",
        accent: "#0f6a3c",
      },
      fonts: {
        body: DESIGN_FONTS.archivo,
        display: DESIGN_FONTS.archivo,
      },
      shape: { card: "8px", control: "6px", sm: "4px", pill: "999px" },
      layout: {
        header: "market",
        headerBackground: "#0f3e38",
        headerForeground: "#ffffff",
        card: "quick_add",
        productDetail: "classic",
        cart: "classic",
        footer: "rich",
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 5,
        shopFilters: true,
        collectionBanner: false,
      },
      typography: {
        headingFont: "body",
        headingScale: "small",
        headingWeight: "semibold",
        headingCase: "none",
        headingTracking: "tight",
      },
      buttons: {
        shape: "rounded",
        primary: "solid",
        secondary: "solid",
        case: "none",
        weight: "semibold",
        tracking: "normal",
        hover: "darken",
      },
      page: { width: "full", sectionGap: "compact", gridGap: "tight" },
      motion: { reveal: "none" },
    },
    templates: {
      product: {
        gallery: "thumbs-bottom",
        blocks: [
          { type: "price" },
          { type: "delivery_estimate" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "trust_row",
            items: [
              { icon: "truck", label: "Same-day delivery by 6 pm" },
              { icon: "leaf", label: "Picked this morning" },
              { icon: "refresh", label: "Replaced if not fresh" },
              { icon: "lock", label: "Pay on delivery or online" },
            ],
          },
          { type: "description" },
          { type: "reviews" },
          { type: "recommendations" },
          { type: "sticky_bar" },
        ],
      },
      collection: {
        filters: "sidebar",
        pagination: "infinite",
        promoTiles: [],
      },
      blog: { index: "grid", article: "narrow" },
      account: { layout: "tabs", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Produce picked at dawn, staples by the kilo and dairy from named farms, delivered the same day across the city.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Picked at dawn, at your door by evening",
                  subheading:
                    "Order by 6 pm and the box comes tonight. Produce, staples, dairy and the odd treat.",
                  cta_label: "Start shopping",
                  cta_href: "/shop",
                  image_url: pic("hero"),
                  video_url: "",
                  background: "#fae3c1",
                  theme: "light",
                  overlay_opacity: 40,
                  content_position: "bottom",
                },
                {
                  heading: "Fresh-baked this morning",
                  subheading: "Cookies, bread and the noodles for tonight.",
                  cta_label: "Shop snacks",
                  cta_href: "/collections/snacks-beverages",
                  image_url: pic("banner-cookies"),
                  video_url: "",
                  background: "#fdf3d8",
                  theme: "light",
                  overlay_opacity: 40,
                  content_position: "bottom",
                },
              ],
              height: "large",
              autoplay: true,
              interval_seconds: 6,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "aisles",
            "shop_by_category",
            {
              heading: "Shop by aisle",
              subheading: "Every aisle, with what is in it",
              source: "all",
              category_ids: [],
              layout: "grid",
              display: "list",
            },
            { padding_y: "sm", width: "contained" },
          ),
          section(
            "offers",
            "tile_grid",
            {
              heading: "This week's offers",
              subheading: "",
              tiles: [
                {
                  title: "Fruit and veg",
                  subtitle: "From ₹39",
                  href: "/collections/fruits-vegetables",
                  image_url: "",
                  background: "#e1f5ee",
                  theme: "dark",
                },
                {
                  title: "Snacks and juices",
                  subtitle: "Up to 20% off",
                  href: "/collections/snacks-beverages",
                  image_url: "",
                  background: "#fdf3d8",
                  theme: "dark",
                },
                {
                  title: "Dairy and eggs",
                  subtitle: "Two farms, named",
                  href: "/collections/dairy-eggs",
                  image_url: "",
                  background: "#e6f1fb",
                  theme: "dark",
                },
                {
                  title: "Household",
                  subtitle: "Weekly essentials",
                  href: "/collections/household",
                  image_url: "",
                  background: "#fbeaf0",
                  theme: "dark",
                },
              ],
              columns: 4,
              height: "sm",
              layout: "grid",
            },
            { padding_y: "sm", width: "contained" },
          ),
          section(
            "picks",
            "featured_products",
            {
              heading: "Fresh picks",
              subheading: "Hand-checked every morning",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 12,
            },
            { padding_y: "sm", width: "contained" },
          ),
          section(
            "promises",
            "usp_bar",
            {
              theme: "light",
              items: [
                {
                  icon: "truck",
                  title: "Same-day delivery",
                  subtitle: "Order by 6 pm",
                },
                {
                  icon: "leaf",
                  title: "Picked at dawn",
                  subtitle: "Produce from four farms",
                },
                {
                  icon: "refresh",
                  title: "Replaced if not fresh",
                  subtitle: "No questions asked",
                },
                {
                  icon: "lock",
                  title: "Pay how you like",
                  subtitle: "Cash, UPI or card",
                },
              ],
            },
            { scheme: "inverse", padding_y: "sm", width: "full" },
          ),
          section(
            "how",
            "multicolumn",
            {
              eyebrow: "How it works",
              heading: "Three steps to tonight's dinner",
              subheading: "",
              items: [
                {
                  icon: "clock",
                  image_url: "",
                  image_alt: "",
                  heading: "Order by 6 pm",
                  body: "Anything in the basket by six is packed by seven.",
                  cta_label: "",
                  cta_href: "",
                },
                {
                  icon: "truck",
                  image_url: "",
                  image_alt: "",
                  heading: "Delivered tonight",
                  body: "Our own riders, in an insulated box, across the city.",
                  cta_label: "",
                  cta_href: "",
                },
                {
                  icon: "badge-check",
                  image_url: "",
                  image_alt: "",
                  heading: "Check it at the door",
                  body: "Anything not fresh is swapped on the spot or refunded.",
                  cta_label: "See the policy",
                  cta_href: "/delivery-and-returns",
                },
              ],
              columns: 3,
              alignment: "left",
              image_ratio: "square",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "questions",
            "faq_accordion",
            {
              heading: "Quick answers",
              subheading: "",
              items: [
                {
                  question: "Is there a minimum order?",
                  answer:
                    "₹299 for delivery. Below that you can collect from the shop on Linking Road any day until 9 pm.",
                  category: "Delivery",
                },
                {
                  question: "What if something is missing or not fresh?",
                  answer:
                    "Tell the rider at the door, or write within 24 hours, and it is refunded or replaced on the next delivery.",
                  category: "Delivery",
                },
                {
                  question: "Where do the vegetables come from?",
                  answer:
                    "Four farms within forty kilometres, named on each product. Nothing is held over from the day before.",
                  category: "Produce",
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
              heading: "Thursday's offers, Wednesday night",
              subheading:
                "One message a week with the weekend's prices. Unsubscribe any time.",
              button_label: "Send me the offers",
              success_message: "Done. The first list comes Wednesday.",
              consent_text:
                "I agree to receive weekly offers from Rahi Daily Mart by email.",
              theme: "light",
              alignment: "center",
            },
            { scheme: "accent", padding_y: "md", width: "full" },
          ),
        ],
      },
      {
        slug: "delivery-and-returns",
        title: "Delivery and Returns",
        seo_description:
          "Rahi Daily Mart delivery slots, the ₹299 minimum, collection from the shop and the fresh-or-replaced promise.",
        sections: [
          section("delivery-rows", "accordion", {
            heading: "Delivery and returns",
            subheading: "The short version, then the details",
            items: [
              {
                type: "text",
                heading: "Slots",
                body: "Orders placed by 6 pm are delivered between 7 and 10 pm the same day. Orders after 6 pm come the next morning between 8 and 11.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Minimum and charges",
                body: "₹299 minimum for delivery, free above ₹999, ₹39 below that. Collection from the shop is free with no minimum.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Not fresh?",
                body: "Show the rider at the door and it is swapped or refunded on the spot. If you notice later, write within 24 hours.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: true,
          }),
          section("delivery-text", "rich_text", {
            html: "<h2>Where we deliver</h2><p>Every pin code in the city, by our own riders in insulated boxes. Dairy and frozen items ride in a separate cold bag. If your building needs a gate pass, add the details at checkout and the rider will call ahead.</p>",
            width: "contained",
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop" },
        { label: "Fruit and veg", href: "/collections/fruits-vegetables" },
        { label: "Staples", href: "/collections/staples" },
        { label: "Dairy", href: "/collections/dairy-eggs" },
        { label: "Delivery", href: "/delivery-and-returns" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "All products", href: "/shop" },
            {
              label: "Snacks and juices",
              href: "/collections/snacks-beverages",
            },
            { label: "Household", href: "/collections/household" },
          ],
        },
        {
          title: "Help",
          links: [
            { label: "Delivery and returns", href: "/delivery-and-returns" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: [
        { label: "Privacy", href: "/privacy-policy" },
        { label: "Terms", href: "/terms" },
        { label: "Refund policy", href: "/refund-policy" },
      ],
    },
    // The theme's own style rules (./stylesheets.ts, plan Phase 3).
    stylesheet: EXEMPLAR_STYLESHEETS["dense-catalogue"],
    sampleData: catalogue,
  },
);
