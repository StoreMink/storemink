// Playful and colourful — "Pop & Peel": a juice and snack shop for families
// on a peach page. Rounded type, pill buttons, a hamburger header, a
// collage of colour tiles, scrolling category cards, a shoppable picture
// and rise motion. Basket's imagery and catalogue.
import { DESIGN_FONTS } from "../fonts";
import { basket } from "../definitions/basket";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";

const ID = "exemplar-playful-and-colourful";
const pic = (name: string) => img(ID, name);
const catalogue = catalogueOf(basket, ID);

export const playfulAndColourful = exemplar(
  exemplarMeta({
    id: ID,
    name: "Pop & Peel",
    description:
      "A playful juice and snack shop on a peach page: rounded type, pill buttons, a colour-tile collage, a shoppable picture and rise motion.",
    direction: "playful-and-colourful",
    engine: "storefront-editorial",
    industries: ["food-and-drink", "kids"],
    catalogSizes: ["small", "medium"],
    features: [
      "cart-drawer",
      "category-navigation",
      "faq",
      "product-filtering",
      "product-recommendations",
      "promo-tiles",
      "quick-add",
    ],
    keywords: ["juice", "snacks", "kids", "colourful", "playful"],
    previewImage: pic("preview"),
    screenshotAlt: "Pop & Peel homepage with a collage of colour tiles",
  }),
  "playful-and-colourful",
  {
    brand: {
      primaryColor: "#c43913",
      tagline: "Snacks that make the lunchbox happy",
      blurb:
        "Cold-pressed juices, fruit, biscuits and the quick dinners a weeknight needs, chosen by two parents who were tired of the same three snacks and delivered in a box the kids argue over.",
    },
    announcement: {
      text: "Build a lunchbox of five and the juice is on us",
      href: "/the-lunchbox-club",
    },
    design: {
      palette: {
        cream: "#fff3e6",
        creamDeep: "#ffe3c8",
        surface: "#fffaf3",
        ink: "#2a1f3d",
        inkSoft: "#584a70",
        inkFaint: "#8d7ea3",
        taupe: "#ffd9b3",
        sand: "#ffe8d1",
        butter: "#fff0c2",
        border: "#f3cfae",
        tile: "#ffe3c8",
        accentWarm: "#ff6b35",
        onAccent: "#ffffff",
        onInk: "#fff3e6",
        shadowRgb: "42, 31, 61",
        success: "#1f8a4c",
        successSoft: "#dff3e6",
        error: "#c92a2a",
        errorSoft: "#fde3e3",
        star: "#f2a900",
        highlight: "#c43913",
        // Deep enough for a white button label at 4.5:1 (5.3:1; the brighter
        // #d6451d carried it at 4.44:1, which axe reports on every solid
        // button). Still the acid-orange the direction asks for.
        accent: "#c43913",
      },
      fonts: {
        body: DESIGN_FONTS.nunito,
        display: DESIGN_FONTS.nunito,
      },
      shape: { card: "24px", control: "16px", sm: "12px", pill: "999px" },
      // The brand band in its own, deeper orange: the derived band (the
      // accent itself) leaves muted copy and card text short of 4.5:1.
      schemes: {
        accent: { background: "#8f2a12", text: "#fff3e6", surface: "#a33318" },
      },
      layout: {
        header: "hamburger",
        card: "quick_add",
        productDetail: "classic",
        cart: "classic",
        footer: "rich",
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 4,
        shopFilters: true,
        collectionBanner: true,
      },
      typography: {
        headingFont: "display",
        headingScale: "large",
        headingWeight: "heavy",
        headingCase: "none",
        headingTracking: "tight",
      },
      buttons: {
        shape: "pill",
        primary: "solid",
        secondary: "solid",
        case: "none",
        weight: "bold",
        tracking: "normal",
        hover: "lift",
      },
      page: { width: "standard", sectionGap: "standard", gridGap: "standard" },
      motion: { reveal: "rise" },
    },
    templates: {
      product: {
        gallery: "carousel",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          { type: "delivery_estimate" },
          {
            type: "trust_row",
            items: [
              { icon: "gift", label: "Free juice with five" },
              { icon: "truck", label: "Next-morning delivery" },
              { icon: "sparkles", label: "No artificial colours" },
            ],
          },
          { type: "description" },
          { type: "share" },
          { type: "reviews" },
          { type: "recommendations" },
          { type: "sticky_bar" },
        ],
      },
      collection: {
        filters: "top-bar",
        pagination: "paged",
        promoTiles: [
          {
            afterIndex: 5,
            heading: "Lunchbox club",
            body: "Five snacks a week, a free juice, and no two weeks the same.",
            cta_label: "Join the club",
            href: "/the-lunchbox-club",
            image_url: "",
            image_alt: "",
            // The declared accent scheme's deep field: the brighter #d6451d
            // held the light copy's body at 3.5:1 (the promo-tile floor).
            theme: "light",
            background: "#8f2a12",
          },
          {
            afterIndex: 12,
            heading: "New this week",
            body: "Hakka noodles for the nights nobody wants to cook.",
            cta_label: "See the noodles",
            href: "/shop/hakka-noodles",
            image_url: "",
            image_alt: "",
            theme: "dark",
            background: "#ffe3c8",
          },
        ],
      },
      blog: { index: "grid", article: "narrow" },
      account: { layout: "plain", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Cold-pressed juices, fruit, biscuits and quick dinners for families, delivered next morning in a box the kids argue over.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Snacks that make the lunchbox happy",
                  subheading:
                    "Juice, fruit and the biscuits they will actually eat, delivered tomorrow morning.",
                  cta_label: "Fill the box",
                  cta_href: "/shop",
                  image_url: pic("hero"),
                  video_url: "",
                  background: "#ffe3c8",
                  theme: "light",
                  overlay_opacity: 35,
                },
                {
                  heading: "Cookies, warm from the oven",
                  subheading: "Baked at six, boxed at seven, yours by nine.",
                  cta_label: "Shop snacks",
                  cta_href: "/collections/snacks-beverages",
                  image_url: pic("banner-cookies"),
                  video_url: "",
                  background: "#ffe3c8",
                  theme: "light",
                  overlay_opacity: 35,
                },
                {
                  heading: "Noodle night, sorted",
                  subheading: "Four packs, one pan, twelve minutes.",
                  cta_label: "See the noodles",
                  cta_href: "/shop/hakka-noodles",
                  image_url: pic("banner-noodles"),
                  video_url: "",
                  background: "#ffe3c8",
                  theme: "light",
                  overlay_opacity: 35,
                },
              ],
              height: "large",
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
                "Free juice with every lunchbox of five",
                "Next-morning delivery before school",
                "No artificial colours, ever",
              ],
              speed: "medium",
              theme: "light",
            },
            { scheme: "accent", padding_y: "sm", width: "full" },
          ),
          section(
            "boxes",
            "tile_grid",
            {
              heading: "Build a box",
              subheading: "",
              tiles: [
                {
                  title: "Fruit",
                  subtitle: "Apples, bananas, the lot",
                  href: "/collections/fruits-vegetables",
                  image_url: "",
                  background: "#ffd166",
                  theme: "dark",
                  span: "2x2",
                },
                {
                  title: "Juices",
                  subtitle: "Cold pressed",
                  href: "/collections/snacks-beverages",
                  image_url: "",
                  background: "#ff9f5a",
                  theme: "dark",
                  span: "1x2",
                },
                {
                  title: "Biscuits",
                  subtitle: "Oven-warm",
                  href: "/collections/snacks-beverages",
                  image_url: "",
                  background: "#9bdcd4",
                  theme: "dark",
                },
                {
                  title: "Milk and eggs",
                  subtitle: "Farm fresh",
                  href: "/collections/dairy-eggs",
                  image_url: "",
                  background: "#c9b8ff",
                  theme: "dark",
                },
                {
                  title: "Weeknight dinners",
                  subtitle: "Noodles, rice, bread",
                  href: "/collections/staples",
                  image_url: "",
                  background: "#ffb3c6",
                  theme: "dark",
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
            "aisles",
            "shop_by_category",
            {
              heading: "Or shop by aisle",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "scroll",
              display: "cards",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "favourites",
            "featured_products",
            {
              heading: "Lunchbox favourites",
              subheading: "What goes in most boxes",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 8,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "shelf",
            "image_hotspots",
            {
              eyebrow: "Shop the shelf",
              heading: "Everything in this picture is in the shop",
              subheading: "Tap a dot to add it to the box.",
              image_url: pic("hero"),
              image_alt: "A grocery shelf with fruit, juice, bread and eggs",
              image_ratio: "landscape",
              hotspots: [
                {
                  x: 22,
                  y: 48,
                  title: "Royal Gala apples",
                  body: "Crisp, sweet, and the right size for a small hand.",
                  href: "/shop/royal-gala-apples",
                  cta_label: "Add apples",
                },
                {
                  x: 55,
                  y: 40,
                  title: "Fresh orange juice",
                  body: "Cold pressed this morning, no added sugar.",
                  href: "/shop/orange-juice",
                  cta_label: "Add juice",
                },
                {
                  x: 80,
                  y: 62,
                  title: "Choco chip cookies",
                  body: "Baked at six. Still soft at lunch.",
                  href: "/shop/choco-chip-cookies",
                  cta_label: "Add cookies",
                },
              ],
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "why",
            "multicolumn",
            {
              eyebrow: "Why parents pick us",
              heading: "Three reasons, from two parents",
              subheading: "",
              items: [
                {
                  icon: "sparkles",
                  image_url: "",
                  image_alt: "",
                  heading: "Nothing artificial",
                  body: "No colours, no preservatives, nothing you cannot say out loud.",
                  cta_label: "",
                  cta_href: "",
                },
                {
                  icon: "truck",
                  image_url: "",
                  image_alt: "",
                  heading: "Before the school run",
                  body: "Order by 9 pm and the box is at the door by 7.",
                  cta_label: "",
                  cta_href: "",
                },
                {
                  icon: "gift",
                  image_url: "",
                  image_alt: "",
                  heading: "A free juice with five",
                  body: "Build a lunchbox of five snacks and we add the juice.",
                  cta_label: "Join the club",
                  cta_href: "/the-lunchbox-club",
                },
              ],
              columns: 3,
              alignment: "center",
              image_ratio: "square",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "club",
            "newsletter",
            {
              eyebrow: "The lunchbox club",
              heading: "A new box idea every Sunday",
              subheading:
                "Five snacks, a recipe for the leftovers, and the week's free juice.",
              button_label: "Join the club",
              success_message: "You are in. Sunday's box is on its way.",
              consent_text:
                "I agree to receive the Pop & Peel lunchbox club email every week.",
              theme: "dark",
              alignment: "center",
            },
            { padding_y: "lg", width: "contained" },
          ),
        ],
      },
      {
        slug: "the-lunchbox-club",
        title: "The Lunchbox Club",
        seo_description:
          "How the Pop & Peel lunchbox club works: five snacks a week, a free juice, and a different box every Sunday.",
        sections: [
          section(
            "club-hero",
            "hero",
            {
              variant: "banner",
              height: "medium",
              heading: "The lunchbox club",
              subheading:
                "Pick any five snacks, we add the juice. A new box idea lands every Sunday, and no two weeks are the same.",
              cta_label: "Start a box",
              cta_href: "/shop",
              image_url: pic("banner-noodles"),
              video_url: "",
              badge_text: "Free juice with five",
              background: "#ffd166",
              theme: "dark",
              alignment: "left",
            },
            { padding_y: "none", width: "contained" },
          ),
          section("club-faq", "faq_accordion", {
            heading: "Club questions",
            subheading: "",
            items: [
              {
                question: "Do I have to subscribe?",
                answer:
                  "No. Any order with five snacks gets the free juice. The Sunday email is just ideas.",
                category: "",
              },
              {
                question: "Can I swap the juice?",
                answer:
                  "Yes, for any juice in the shop. Tell us at checkout which one.",
                category: "",
              },
              {
                question: "What if the kids hate something?",
                answer:
                  "Tell us and we will swap it on the next box, free. We keep a list of what each family will not eat.",
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
        { label: "Fruit", href: "/collections/fruits-vegetables" },
        { label: "Snacks and juice", href: "/collections/snacks-beverages" },
        { label: "Dinners", href: "/collections/staples" },
        { label: "Lunchbox club", href: "/the-lunchbox-club" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Milk and eggs", href: "/collections/dairy-eggs" },
            { label: "Household", href: "/collections/household" },
          ],
        },
        {
          title: "Help",
          links: [
            { label: "Lunchbox club", href: "/the-lunchbox-club" },
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
