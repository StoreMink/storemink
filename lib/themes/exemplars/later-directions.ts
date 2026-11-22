// ---------------------------------------------------------------------------
// The seven later design directions (lib/theme-studio/design-directions.ts
// EXTENDED_DESIGN_DIRECTIONS, prompt v34), one hand-authored exemplar each,
// held to every gate the first seven are (exemplars.test.ts).
//
// One file, with a few local builders for the shapes every theme repeats (a
// slide, a tile, a palette's status colours): what differs between the seven
// is on the page, not buried in boilerplate. Each theme follows its
// direction's layout signature (lib/theme-studio/commitments.ts) and carries
// its own stylesheet (./stylesheets.ts). They borrow the bundled themes'
// imagery and catalogues through linked folders, like the first seven.
// ---------------------------------------------------------------------------
import { DESIGN_FONTS } from "../fonts";
import { basket } from "../definitions/basket";
import { ritual } from "../definitions/ritual";
import { studio } from "../definitions/studio";
import { vitrine } from "../definitions/vitrine";
import type { ThemePalette } from "../types";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";
import { EXEMPLAR_STYLESHEETS } from "./stylesheets";

type Tone = "light" | "dark";

/** A carousel slide: a photograph, a line, a link. */
const slide = (
  heading: string,
  subheading: string,
  cta_label: string,
  cta_href: string,
  image_url: string,
  background: string,
  theme: Tone = "light",
) => ({
  heading,
  subheading,
  cta_label,
  cta_href,
  image_url,
  video_url: "",
  background,
  theme,
  overlay_opacity: 45,
  content_position: "bottom" as const,
});

/** A colour-field tile: a title, a line, a link. */
const tile = (
  title: string,
  subtitle: string,
  href: string,
  background: string,
  theme: Tone = "dark",
) => ({ title, subtitle, href, image_url: "", background, theme });

/** The status colours a palette carries, for a light or a dark page. */
const status = (dark: boolean) =>
  dark
    ? {
        success: "#7ddc8a",
        successSoft: "#1d2a1f",
        error: "#ff7b72",
        errorSoft: "#2a1c1c",
        star: "#f2c14e",
      }
    : {
        success: "#2e7d32",
        successSoft: "#e8f5e9",
        error: "#b3261e",
        errorSoft: "#fdeeec",
        star: "#b97a00",
      };

const signup = (
  heading: string,
  subheading: string,
  button_label: string,
  brand: string,
  theme: Tone,
  alignment: "left" | "center" = "center",
) => ({
  eyebrow: "",
  heading,
  subheading,
  button_label,
  success_message: "Thank you. The first letter is on its way.",
  consent_text: `I agree to receive emails from ${brand}.`,
  theme,
  alignment,
});

const legal = [
  { label: "Privacy", href: "/privacy-policy" },
  { label: "Terms", href: "/terms" },
  { label: "Refund policy", href: "/refund-policy" },
];

// ── Brutalist: "KERB" ──────────────────────────────────────────────────────
// Shoes and bags sold like stock on a loading dock: a hamburger header, wide
// cards in a full-width grid, thick rules, no corners, no motion.
const KERB = "exemplar-brutalist";
const kerbPic = (name: string) => img(KERB, name);
const kerbPalette: ThemePalette = {
  cream: "#f1f1ee",
  creamDeep: "#e4e4df",
  surface: "#ffffff",
  ink: "#0b0b0b",
  inkSoft: "#3d3d3d",
  inkFaint: "#8b8b86",
  taupe: "#e4e4df",
  sand: "#deded8",
  butter: "#fff36b",
  border: "#bdbdb6",
  tile: "#e9e9e4",
  accentWarm: "#d43a12",
  onAccent: "#0b0b0b",
  onInk: "#f1f1ee",
  shadowRgb: "0, 0, 0",
  highlight: "#d43a12",
  accent: "#ff4a1c",
  ...status(false),
};

export const brutalist = exemplar(
  exemplarMeta({
    id: KERB,
    name: "KERB",
    description:
      "A brutalist stock room: a hamburger header, wide cards in a full-width grid, thick rules, square corners and no motion.",
    direction: "brutalist",
    engine: "storefront-editorial",
    industries: ["clothing", "shoes"],
    catalogSizes: ["small", "medium"],
    features: [
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["brutalist", "streetwear", "stock", "raw"],
    previewImage: kerbPic("preview"),
    screenshotAlt: "KERB homepage with a full-band photograph and a ticker",
  }),
  "brutalist",
  {
    brand: {
      primaryColor: "#ff4a1c",
      tagline: "Stock, priced plainly",
      blurb:
        "Shoes and bags listed like stock on a loading dock: what it is, what it is made of, what it costs. No seasons and no stories.",
    },
    announcement: {
      text: "New stock every Tuesday at noon. Sizes are listed as they are.",
      href: "/shop",
    },
    design: {
      palette: kerbPalette,
      fonts: { body: DESIGN_FONTS.inter, display: DESIGN_FONTS.jetbrainsMono },
      shape: { card: "0px", control: "0px", sm: "0px", pill: "0px" },
      layout: {
        header: "hamburger",
        card: "wide",
        productDetail: "stacked",
        cart: "classic",
        footer: "compact",
        stickyAddToCart: false,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 4,
        shopFilters: true,
        collectionBanner: false,
        cardHoverImage: false,
      },
      typography: {
        headingFont: "display",
        headingScale: "xlarge",
        headingWeight: "heavy",
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
        hover: "darken",
      },
      page: { width: "full", sectionGap: "compact", gridGap: "tight" },
      motion: { reveal: "none" },
    },
    templates: {
      product: {
        gallery: "grid",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "accordion",
            rows: [
              {
                heading: "What it is made of",
                body: "Full-grain leather upper, rubber cupsole, cotton laces. Nothing bonded that could be stitched.",
              },
              {
                heading: "Sizing",
                body: "True to size. Half sizes go up. Every pair is measured before it is listed.",
              },
              {
                heading: "Returns",
                body: "Seven days, unworn, in the box it came in. We pay the courier.",
              },
            ],
          },
          { type: "description" },
          { type: "reviews" },
          { type: "recommendations" },
        ],
      },
      collection: {
        filters: "top-bar",
        pagination: "load-more",
        promoTiles: [],
      },
      blog: { index: "list", article: "wide" },
      account: { layout: "plain", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Shoes and bags listed like stock: what it is, what it is made of and what it costs. New stock every Tuesday.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                slide(
                  "Stock, priced plainly",
                  "No seasons. No stories. What is on the shelf is what there is.",
                  "See the stock",
                  "/shop",
                  kerbPic("hero"),
                  "#1c1c1c",
                ),
                slide(
                  "Tuesday, noon",
                  "New pairs go up once a week and stay until they are gone.",
                  "Shop shoes",
                  "/collections/mens-shoes",
                  kerbPic("sneaker"),
                  "#2a2a2a",
                ),
              ],
              height: "large",
              autoplay: false,
              interval_seconds: 6,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "wire",
            "ticker",
            {
              messages: [
                "New stock Tuesday noon",
                "Seven-day returns, courier paid",
                "Every pair measured before listing",
                "Prices include tax",
              ],
              speed: "medium",
              theme: "dark",
            },
            { scheme: "inverse", padding_y: "sm", width: "full" },
          ),
          section(
            "stock",
            "featured_products",
            {
              heading: "On the shelf",
              subheading: "",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 8,
            },
            { padding_y: "md", width: "full" },
          ),
          section(
            "which",
            "comparison",
            {
              heading: "Three soles",
              subheading: "Pick by the ground you walk on",
              columns: [
                {
                  label: "Cupsole",
                  caption: "Pavement",
                  cta_label: "Shop sneakers",
                  cta_href: "/collections/mens-shoes",
                  highlight: true,
                },
                {
                  label: "Lugged",
                  caption: "Rain and gravel",
                  cta_label: "Shop boots",
                  cta_href: "/collections/womens-shoes",
                  highlight: false,
                },
                {
                  label: "Welted leather",
                  caption: "Floors",
                  cta_label: "Shop loafers",
                  cta_href: "/collections/mens-shoes",
                  highlight: false,
                },
              ],
              rows: [
                {
                  type: "text",
                  label: "Weight per shoe",
                  values: ["410 g", "620 g", "480 g"],
                },
                {
                  type: "check",
                  label: "Resoleable",
                  values: ["no", "yes", "yes"],
                },
                {
                  type: "check",
                  label: "Wet ground",
                  values: ["no", "yes", "no"],
                },
              ],
              style: "table",
            },
            { scheme: "soft", padding_y: "md", width: "contained" },
          ),
          section(
            "floor",
            "gallery",
            {
              heading: "The floor",
              subheading: "",
              items: [
                {
                  image_url: kerbPic("boot"),
                  image_alt: "A black lugged ankle boot",
                  caption: "Boot, black",
                  href: "/shop/rowan-ankle-boot",
                },
                {
                  image_url: kerbPic("tote"),
                  image_alt: "A black structured tote bag",
                  caption: "Tote, black",
                  href: "/shop/astrid-structured-tote",
                },
                {
                  image_url: kerbPic("loafer"),
                  image_alt: "A brown penny loafer",
                  caption: "Loafer, tan",
                  href: "/shop/marlowe-leather-loafer",
                },
                {
                  image_url: kerbPic("belt"),
                  image_alt: "A reversible leather belt",
                  caption: "Belt, two sides",
                  href: "/shop/corbin-reversible-belt",
                },
              ],
              layout: "grid",
              columns: 4,
              image_ratio: "square",
            },
            { padding_y: "md", width: "full" },
          ),
          section(
            "signup",
            "newsletter",
            signup(
              "One line, every Tuesday",
              "What went up, in what sizes. Nothing else.",
              "Send it",
              "KERB",
              "dark",
              "left",
            ),
            { scheme: "inverse", padding_y: "md", width: "full" },
          ),
        ],
      },
      {
        slug: "how-we-list",
        title: "How We List",
        seo_description:
          "How KERB lists stock: measured sizes, materials named in full, prices that include tax and seven-day returns.",
        sections: [
          section("list-text", "rich_text", {
            html: "<h2>How we list</h2><p>Every item is photographed on the same floor, measured by hand and listed with what it is made of. A price includes tax and does not change until the stock is gone.</p>",
            width: "contained",
          }),
          section("list-rows", "accordion", {
            heading: "The rules",
            subheading: "",
            items: [
              {
                type: "text",
                heading: "Sizes",
                body: "Listed as measured, in centimetres as well as the number on the box.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Returns",
                body: "Seven days from delivery, unworn. We book and pay the courier.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: false,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Stock", href: "/shop" },
        { label: "Shoes", href: "/collections/mens-shoes" },
        { label: "Bags", href: "/collections/handbags" },
        { label: "How we list", href: "/how-we-list" },
      ],
      footerGroups: [
        {
          title: "Stock",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Accessories", href: "/collections/accessories" },
          ],
        },
        {
          title: "Help",
          links: [
            { label: "How we list", href: "/how-we-list" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: legal,
    },
    stylesheet: EXEMPLAR_STYLESHEETS.brutalist,
    sampleData: catalogueOf(vitrine, KERB),
  },
);

// ── Scandinavian utility: "Hylla" ──────────────────────────────────────────
// Furniture for small homes, shown plainly: a minimal header, quiet classic
// cards three across, a stone-coloured page, hairlines and wide gaps.
const HYLLA = "exemplar-scandinavian-utility";
const hyllaPic = (name: string) => img(HYLLA, name);
const hyllaPalette: ThemePalette = {
  cream: "#dcd8cf",
  creamDeep: "#d0ccc2",
  surface: "#f4f2ec",
  ink: "#22262a",
  inkSoft: "#454b52",
  inkFaint: "#7d8187",
  taupe: "#cfcabf",
  sand: "#d3cec3",
  butter: "#e9dfb8",
  border: "#bdb8ac",
  tile: "#e6e3db",
  accentWarm: "#264f54",
  onAccent: "#ffffff",
  onInk: "#f4f2ec",
  shadowRgb: "34, 38, 42",
  highlight: "#264f54",
  accent: "#264f54",
  ...status(false),
};

export const scandinavianUtility = exemplar(
  exemplarMeta({
    id: HYLLA,
    name: "Hylla",
    description:
      "Scandinavian utility: a minimal header, quiet cards three across on a stone-coloured page, hairline dividers and generous space.",
    direction: "scandinavian-utility",
    engine: "storefront-editorial",
    industries: ["home", "office"],
    catalogSizes: ["small", "medium"],
    features: [
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["scandinavian", "utility", "furniture", "calm"],
    previewImage: hyllaPic("preview"),
    screenshotAlt: "Hylla homepage with a calm living room photograph",
  }),
  "scandinavian-utility",
  {
    brand: {
      primaryColor: "#264f54",
      tagline: "Useful things for small homes",
      blurb:
        "Furniture and lighting for homes where every piece has to earn its place: solid wood, honest joints, and nothing that needs a manual.",
    },
    announcement: {
      text: "Free delivery and assembly on orders over ₹15,000",
      href: "/materials-and-care",
    },
    design: {
      palette: hyllaPalette,
      fonts: { body: DESIGN_FONTS.manrope, display: DESIGN_FONTS.manrope },
      shape: { card: "6px", control: "4px", sm: "3px", pill: "999px" },
      layout: {
        header: "minimal",
        card: "classic",
        productDetail: "classic",
        cart: "classic",
        footer: "minimal",
        stickyAddToCart: false,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 3,
        shopFilters: true,
        collectionBanner: false,
        cardHoverImage: false,
      },
      typography: {
        headingFont: "body",
        headingScale: "medium",
        headingWeight: "medium",
        headingCase: "none",
        headingTracking: "normal",
      },
      buttons: {
        shape: "rounded",
        primary: "solid",
        secondary: "text",
        case: "none",
        weight: "medium",
        tracking: "normal",
        hover: "darken",
      },
      page: { width: "standard", sectionGap: "airy", gridGap: "roomy" },
      motion: { reveal: "none" },
    },
    templates: {
      product: {
        gallery: "thumbs-left",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          { type: "delivery_estimate" },
          {
            type: "trust_row",
            items: [
              { icon: "truck", label: "Delivered and assembled" },
              { icon: "shield", label: "Ten-year frame guarantee" },
              { icon: "refresh", label: "Thirty days to return" },
            ],
          },
          { type: "description" },
          { type: "reviews" },
          { type: "recommendations" },
        ],
      },
      collection: { filters: "sidebar", pagination: "paged", promoTiles: [] },
      blog: { index: "grid", article: "narrow" },
      account: { layout: "sidebar", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Solid wood furniture and lighting for small homes, delivered and assembled, with a ten-year frame guarantee.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                slide(
                  "Useful things for small homes",
                  "Solid wood, honest joints, nothing that needs a manual.",
                  "Shop furniture",
                  "/shop",
                  hyllaPic("hero"),
                  "#cfcabf",
                ),
                slide(
                  "A chair for forty years",
                  "Oak frame, wool seat, and a guarantee to match.",
                  "Shop seating",
                  "/collections/seating",
                  hyllaPic("chair"),
                  "#d3cec3",
                ),
              ],
              height: "large",
              autoplay: false,
              interval_seconds: 8,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "promises",
            "usp_bar",
            {
              theme: "light",
              items: [
                {
                  icon: "truck",
                  title: "Delivered and assembled",
                  subtitle: "In the room you choose",
                },
                {
                  icon: "shield",
                  title: "Ten-year guarantee",
                  subtitle: "On every frame",
                },
                {
                  icon: "refresh",
                  title: "Thirty days to decide",
                  subtitle: "We collect it if not",
                },
              ],
            },
            { padding_y: "sm", width: "contained" },
          ),
          section(
            "rooms",
            "shop_by_category",
            {
              heading: "By kind",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "grid",
              display: "cards",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "wood",
            "media_text",
            {
              eyebrow: "Materials",
              heading: "Oak, ash and wool",
              body: "Three materials cover almost everything we make. Each is chosen because it wears well, mends easily and looks better at ten years than at one.",
              cta_label: "Materials and care",
              cta_href: "/materials-and-care",
              image_url: hyllaPic("side-table"),
              image_alt: "A small round side table in pale oak",
              media_position: "right",
              media_ratio: "landscape",
              alignment: "left",
              stories: [],
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "new",
            "featured_products",
            {
              heading: "In the workshop this month",
              subheading: "",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 6,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "how",
            "multicolumn",
            {
              eyebrow: "",
              heading: "How an order goes",
              subheading: "",
              items: [
                {
                  icon: "clock",
                  image_url: "",
                  image_alt: "",
                  heading: "Made in three weeks",
                  body: "Most pieces are built to order in our Pune workshop.",
                  cta_label: "",
                  cta_href: "",
                },
                {
                  icon: "truck",
                  image_url: "",
                  image_alt: "",
                  heading: "Carried in",
                  body: "Two people bring it up, assemble it and take the packing away.",
                  cta_label: "",
                  cta_href: "",
                },
                {
                  icon: "heart",
                  image_url: "",
                  image_alt: "",
                  heading: "Looked after",
                  body: "Write to us any year you own it and we will send parts or advice.",
                  cta_label: "",
                  cta_href: "",
                },
              ],
              columns: 3,
              alignment: "left",
              image_ratio: "square",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "signup",
            "newsletter",
            signup(
              "A letter each season",
              "New pieces, and how to care for the ones you have.",
              "Subscribe",
              "Hylla",
              "light",
              "left",
            ),
            { scheme: "tint", padding_y: "md", width: "contained" },
          ),
        ],
      },
      {
        slug: "materials-and-care",
        title: "Materials and Care",
        seo_description:
          "The oak, ash and wool Hylla uses, how each wears over the years and how to look after it.",
        sections: [
          section("care-text", "rich_text", {
            html: "<h2>Materials and care</h2><p>Oak and ash are oiled, not lacquered, so a scratch can be sanded out and re-oiled at home. Wool covers lift off for cleaning. Every piece comes with a small tin of the oil it was finished with.</p>",
            width: "contained",
          }),
          section("care-rows", "accordion", {
            heading: "Looking after it",
            subheading: "",
            items: [
              {
                type: "text",
                heading: "Wood",
                body: "Wipe with a dry cloth. Re-oil once a year, or when water stops beading on the surface.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Wool",
                body: "Vacuum weekly. Covers can be dry cleaned; spills should be blotted, never rubbed.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: true,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop" },
        { label: "Seating", href: "/collections/seating" },
        { label: "Lighting", href: "/collections/lighting" },
        { label: "Care", href: "/materials-and-care" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Objects", href: "/collections/objects" },
          ],
        },
        {
          title: "Help",
          links: [
            { label: "Materials and care", href: "/materials-and-care" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: legal,
    },
    stylesheet: EXEMPLAR_STYLESHEETS["scandinavian-utility"],
    sampleData: catalogueOf(studio, HYLLA),
  },
);

// ── Maximal pattern: "Mor Bagh" ────────────────────────────────────────────
// A perfumery that is not afraid of colour: a mustard page, plum type, a
// stacked header, soft tiles, a marquee of bottles and bands in every scheme.
const MOR = "exemplar-maximal-pattern";
const morPic = (name: string) => img(MOR, name);
const morPalette: ThemePalette = {
  cream: "#f2c14e",
  creamDeep: "#e9b53b",
  surface: "#fff6dc",
  ink: "#2a0f3d",
  inkSoft: "#44245a",
  inkFaint: "#7a5f86",
  taupe: "#e6a9c0",
  sand: "#f7d98a",
  butter: "#ffe9a8",
  border: "#c9962a",
  tile: "#f8dfa0",
  accentWarm: "#741449",
  onAccent: "#ffffff",
  onInk: "#fff6dc",
  shadowRgb: "42, 15, 61",
  highlight: "#741449",
  accent: "#741449",
  ...status(false),
  // The stock red reads at 3.89:1 on mustard; a sale price needs 4.5:1.
  error: "#8c1016",
};

export const maximalPattern = exemplar(
  exemplarMeta({
    id: MOR,
    name: "Mor Bagh",
    description:
      "Maximal and patterned: a mustard page with plum type, a stacked header, soft tiles, an image marquee and bands in several schemes.",
    direction: "maximal-pattern",
    engine: "storefront-editorial",
    industries: ["beauty", "home"],
    catalogSizes: ["small", "medium"],
    features: [
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "promo-tiles",
      "variant-picker",
    ],
    keywords: ["maximal", "pattern", "colour", "perfumery"],
    previewImage: morPic("preview"),
    screenshotAlt: "Mor Bagh homepage on a mustard page with plum headings",
  }),
  "maximal-pattern",
  {
    brand: {
      primaryColor: "#741449",
      tagline: "Scent, colour and a little too much of both",
      blurb:
        "A perfumery and bath house that believes more is more: attars, oils and candles blended in Kannauj and dressed in every colour of the garden.",
    },
    announcement: {
      text: "A sample vial of this month's attar with every order",
      href: "/the-garden",
    },
    design: {
      palette: morPalette,
      fonts: {
        body: DESIGN_FONTS.figtree,
        display: DESIGN_FONTS.playfairDisplay,
      },
      shape: { card: "20px", control: "12px", sm: "8px", pill: "999px" },
      layout: {
        header: "stacked",
        card: "soft",
        productDetail: "editorial",
        cart: "classic",
        footer: "editorial",
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 3,
        shopFilters: true,
        collectionBanner: true,
        cardHoverImage: false,
      },
      typography: {
        headingFont: "display",
        headingScale: "xlarge",
        headingWeight: "bold",
        headingCase: "none",
        headingTracking: "normal",
      },
      buttons: {
        shape: "pill",
        primary: "solid",
        secondary: "outline",
        case: "none",
        weight: "semibold",
        tracking: "normal",
        hover: "lift",
      },
      page: { width: "wide", sectionGap: "standard", gridGap: "standard" },
      motion: { reveal: "rise" },
    },
    templates: {
      product: {
        gallery: "carousel",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "trust_row",
            items: [
              { icon: "gift", label: "Wrapped in block-printed paper" },
              { icon: "leaf", label: "No synthetic musks" },
              { icon: "truck", label: "Sent within two days" },
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
        filters: "drawer",
        pagination: "infinite",
        promoTiles: [
          {
            afterIndex: 4,
            heading: "The garden",
            body: "Where the roses, vetiver and marigold in every bottle are grown.",
            cta_label: "Walk through it",
            href: "/the-garden",
            image_url: "",
            image_alt: "",
            theme: "light",
            background: "#741449",
          },
        ],
      },
      blog: { index: "featured", article: "wide" },
      account: { layout: "tabs", scheme: "soft" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Attars, bath oils and candles blended in Kannauj, with a sample vial of this month's attar in every order.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                slide(
                  "More is more",
                  "Attars, oils and candles in every colour of the garden.",
                  "Come in",
                  "/shop",
                  morPic("hero"),
                  "#5b1735",
                ),
                slide(
                  "This month: marigold",
                  "Bright, green and a little peppery.",
                  "Smell it",
                  "/shop/soft-earth-botanical-scent",
                  morPic("perfume"),
                  "#741449",
                ),
                slide(
                  "Light the evening",
                  "A candle poured in a brass tumbler you keep.",
                  "Shop home",
                  "/collections/home",
                  morPic("candle"),
                  "#2a0f3d",
                ),
              ],
              height: "large",
              autoplay: true,
              interval_seconds: 5,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "shelf",
            "image_marquee",
            {
              items: [
                {
                  image_url: morPic("serum"),
                  image_alt: "A glass dropper bottle of facial serum",
                  href: "/collections/face",
                },
                {
                  image_url: morPic("body-oil"),
                  image_alt: "A bottle of amber body oil",
                  href: "/collections/body",
                },
                {
                  image_url: morPic("bath-soak"),
                  image_alt: "A jar of mineral bath soak",
                  href: "/collections/body",
                },
                {
                  image_url: morPic("massage-stone"),
                  image_alt: "A smooth stone for facial massage",
                  href: "/collections/tools",
                },
              ],
              speed: "medium",
              size: "lg",
              image_ratio: "portrait",
            },
            { scheme: "accent", padding_y: "md", width: "full" },
          ),
          section(
            "rooms",
            "tile_grid",
            {
              heading: "Four rooms",
              subheading: "Each with its own colour",
              tiles: [
                tile(
                  "Face",
                  "Cleansers and serums",
                  "/collections/face",
                  "#e6a9c0",
                ),
                tile("Body", "Oils and soaks", "/collections/body", "#fff6dc"),
                tile(
                  "Home",
                  "Candles",
                  "/collections/home",
                  "#2a0f3d",
                  "light",
                ),
                tile(
                  "Tools",
                  "Stone and brass",
                  "/collections/tools",
                  "#741449",
                  "light",
                ),
              ],
              columns: 4,
              height: "md",
              layout: "grid",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "spot",
            "product_spotlight",
            {
              eyebrow: "Bottle of the month",
              heading: "",
              body: "Distilled over sandalwood in copper stills, the old way, and aged a year before it is bottled.",
              source: "featured",
              product_id: null,
              media_position: "left",
              cta_label: "Take it home",
              show_price: true,
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "said",
            "testimonials",
            {
              eyebrow: "Overheard",
              heading: "What people say on the way out",
              subheading: "",
              items: [
                {
                  quote:
                    "I came for one candle and left smelling of four things. No regrets.",
                  author: "Meher K.",
                  detail: "Jaipur",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote:
                    "The wrapping paper is now framed on my wall, which says it all.",
                  author: "Dev A.",
                  detail: "Mumbai",
                  logo_url: "",
                  logo_alt: "",
                },
              ],
              layout: "editorial",
              columns: 2,
            },
            { scheme: "inverse", padding_y: "lg", width: "full" },
          ),
          section(
            "more",
            "featured_products",
            {
              heading: "And a little more",
              subheading: "",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 6,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "signup",
            "newsletter",
            signup(
              "A scented letter",
              "Each month's attar, described before it is bottled.",
              "Write to me",
              "Mor Bagh",
              "light",
            ),
            { scheme: "tint", padding_y: "md", width: "full" },
          ),
        ],
      },
      {
        slug: "the-garden",
        title: "The Garden",
        seo_description:
          "The garden outside Kannauj where the roses, vetiver and marigold in every Mor Bagh bottle are grown and distilled.",
        sections: [
          section("garden-text", "rich_text", {
            html: "<h2>The garden</h2><p>Four acres outside Kannauj, planted in rows by colour. Roses are picked before sunrise and in the still by eight; vetiver roots wait a year in clay jars. Nothing in a bottle has travelled further than the next field.</p>",
            width: "contained",
          }),
          section("garden-rows", "accordion", {
            heading: "Through the year",
            subheading: "",
            items: [
              {
                type: "text",
                heading: "Winter",
                body: "Roses and marigold. The stills run from dawn until the petals are gone.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Monsoon",
                body: "Vetiver is lifted, washed and laid up in clay to rest until next year.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: true,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop" },
        { label: "Face", href: "/collections/face" },
        { label: "Body", href: "/collections/body" },
        { label: "Home", href: "/collections/home" },
        { label: "The garden", href: "/the-garden" },
      ],
      footerGroups: [
        {
          title: "Rooms",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Tools", href: "/collections/tools" },
          ],
        },
        {
          title: "House",
          links: [
            { label: "The garden", href: "/the-garden" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: legal,
    },
    stylesheet: EXEMPLAR_STYLESHEETS["maximal-pattern"],
    sampleData: catalogueOf(ritual, MOR),
  },
);

// ── Dark luxury: "Nocturne" ────────────────────────────────────────────────
// Leather goods shown at night: a near-black page, a header that floats over
// the photograph, framed cards one to a phone row, fine serif capitals.
const NOCT = "exemplar-dark-luxury";
const noctPic = (name: string) => img(NOCT, name);
const noctPalette: ThemePalette = {
  cream: "#100f11",
  creamDeep: "#18171a",
  surface: "#1b1a1d",
  ink: "#f1ece3",
  inkSoft: "#c4bdb1",
  inkFaint: "#857f76",
  taupe: "#26242a",
  sand: "#1f1e22",
  butter: "#2b261c",
  border: "#34312f",
  tile: "#1d1c1f",
  accentWarm: "#c9a56a",
  onAccent: "#100f11",
  onInk: "#100f11",
  shadowRgb: "0, 0, 0",
  highlight: "#c9a56a",
  accent: "#c9a56a",
  ...status(true),
};

export const darkLuxury = exemplar(
  exemplarMeta({
    id: NOCT,
    name: "Nocturne",
    description:
      "Dark luxury: a near-black page, a header floating over the photograph, framed cards, fine serif capitals and slow fades.",
    direction: "dark-luxury",
    engine: "storefront-editorial",
    industries: ["jewelry-and-accessories", "clothing"],
    catalogSizes: ["one-product", "small"],
    features: [
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["dark", "luxury", "leather", "evening"],
    previewImage: noctPic("preview"),
    screenshotAlt: "Nocturne homepage, a dark page with a full-band photograph",
  }),
  "dark-luxury",
  {
    brand: {
      primaryColor: "#c9a56a",
      tagline: "Made for after dark",
      blurb:
        "Shoes and bags in black calf and brushed brass, made in runs of thirty and sold by appointment or here, quietly.",
    },
    announcement: {
      text: "Private appointments in Delhi and Mumbai, by request",
      href: "/private-appointments",
    },
    design: {
      palette: noctPalette,
      fonts: {
        body: DESIGN_FONTS.manrope,
        display: DESIGN_FONTS.cormorantGaramond,
      },
      shape: { card: "2px", control: "0px", sm: "0px", pill: "999px" },
      layout: {
        header: "transparent",
        card: "framed",
        productDetail: "editorial",
        cart: "classic",
        footer: "editorial",
        stickyAddToCart: false,
        gridColumnsMobile: 1,
        gridColumnsDesktop: 3,
        shopFilters: true,
        collectionBanner: true,
        cardHoverImage: true,
      },
      typography: {
        headingFont: "display",
        headingScale: "large",
        headingWeight: "regular",
        headingCase: "uppercase",
        headingTracking: "wide",
      },
      buttons: {
        shape: "square",
        primary: "solid",
        secondary: "text",
        case: "uppercase",
        weight: "medium",
        tracking: "wide",
        hover: "invert",
      },
      page: { width: "narrow", sectionGap: "airy", gridGap: "roomy" },
      motion: { reveal: "fade" },
    },
    templates: {
      product: {
        gallery: "stacked",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "accordion",
            rows: [
              {
                heading: "The leather",
                body: "Black box calf from a single tannery, hand-burnished at the edges until it holds a low shine.",
              },
              {
                heading: "Delivery",
                body: "Sent by hand in Delhi and Mumbai, and by insured courier elsewhere within five days.",
              },
            ],
          },
          { type: "description" },
          { type: "share" },
          { type: "reviews" },
          { type: "recommendations" },
        ],
      },
      collection: { filters: "drawer", pagination: "paged", promoTiles: [] },
      blog: { index: "list", article: "narrow" },
      account: { layout: "plain", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Shoes and bags in black calf and brushed brass, made in runs of thirty. Private appointments in Delhi and Mumbai.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                slide(
                  "Made for after dark",
                  "Black calf, brushed brass, thirty of each.",
                  "Enter",
                  "/shop",
                  noctPic("hero"),
                  "#100f11",
                ),
                slide(
                  "The evening tote",
                  "Structured, unlined, and lighter than it looks.",
                  "See the tote",
                  "/shop/astrid-structured-tote",
                  noctPic("tote"),
                  "#18171a",
                ),
              ],
              height: "screen",
              autoplay: false,
              interval_seconds: 8,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "house",
            "media_text",
            {
              eyebrow: "The house",
              heading: "Thirty, then no more",
              body: "Each style is cut from one batch of hides, so a run ends when the leather does. We would rather sell out than match a colour badly.",
              cta_label: "By appointment",
              cta_href: "/private-appointments",
              image_url: noctPic("heel"),
              image_alt: "A black block-heel sandal on dark stone",
              media_position: "left",
              media_ratio: "portrait",
              alignment: "left",
              stories: [],
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "edit",
            "shop_by_category",
            {
              heading: "The edit",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "scroll",
              display: "cards",
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "plates",
            "gallery",
            {
              heading: "Plates",
              subheading: "",
              items: [
                {
                  image_url: noctPic("crossbody"),
                  image_alt: "A black quilted crossbody bag",
                  caption: "Crossbody",
                  href: "/shop/nyla-quilted-crossbody",
                },
                {
                  image_url: noctPic("sunglasses"),
                  image_alt: "Angular dark sunglasses",
                  caption: "Sunglasses",
                  href: "/shop/halden-angular-sunglasses",
                },
                {
                  image_url: noctPic("boot"),
                  image_alt: "A black leather ankle boot",
                  caption: "Boot",
                  href: "/shop/rowan-ankle-boot",
                },
              ],
              layout: "editorial",
              columns: 3,
              image_ratio: "portrait",
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "said",
            "testimonials",
            {
              eyebrow: "",
              heading: "From clients",
              subheading: "",
              items: [
                {
                  quote:
                    "It arrived by hand, in a cloth bag, with a note from the person who made it.",
                  author: "A. Mehra",
                  detail: "New Delhi",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote:
                    "Two years of evenings and the edges are only better for it.",
                  author: "S. Rao",
                  detail: "Mumbai",
                  logo_url: "",
                  logo_alt: "",
                },
              ],
              layout: "editorial",
              columns: 2,
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "signup",
            "newsletter",
            signup(
              "Before each run",
              "One note when a new style is ready, a week before it is shown.",
              "Notify me",
              "Nocturne",
              "dark",
            ),
            { scheme: "soft", padding_y: "lg", width: "full" },
          ),
        ],
      },
      {
        slug: "private-appointments",
        title: "Private Appointments",
        seo_description:
          "Private appointments with Nocturne in Delhi and Mumbai: see a run before it is shown and be measured for a last.",
        sections: [
          section("appt-text", "rich_text", {
            html: "<h2>Private appointments</h2><p>An hour, by request, in Delhi or Mumbai. You see the run before it is shown, try every size, and can be measured for a last kept under your name.</p>",
            width: "contained",
          }),
          section("appt-rows", "accordion", {
            heading: "What to expect",
            subheading: "",
            items: [
              {
                type: "text",
                heading: "Booking",
                body: "Write through the enquiry page with two dates that suit you. We reply within a day.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Made to measure",
                body: "A last takes four weeks. Every later pair is cut to it without another fitting.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: false,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop" },
        { label: "Shoes", href: "/collections/womens-shoes" },
        { label: "Bags", href: "/collections/handbags" },
        { label: "Appointments", href: "/private-appointments" },
      ],
      footerGroups: [
        {
          title: "The house",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Appointments", href: "/private-appointments" },
          ],
        },
        {
          title: "Help",
          links: [
            { label: "Enquiries", href: "/enquiries" },
            { label: "Accessories", href: "/collections/accessories" },
          ],
        },
      ],
      footerLegal: legal,
    },
    stylesheet: EXEMPLAR_STYLESHEETS["dark-luxury"],
    sampleData: catalogueOf(vitrine, NOCT),
  },
);

// ── Retro catalogue: "Ganapati Provisions" ─────────────────────────────────
// A grocer's printed price list: a paper-coloured page, a utility bar over
// the brand row, framed cards, ruled tables and stamped badges.
const GANA = "exemplar-retro-catalogue";
const ganaPic = (name: string) => img(GANA, name);
const ganaPalette: ThemePalette = {
  cream: "#e6d9bd",
  creamDeep: "#dccdab",
  surface: "#f6eeda",
  ink: "#2a2016",
  inkSoft: "#4f4234",
  inkFaint: "#8c7c68",
  taupe: "#d8c79f",
  sand: "#decfa9",
  butter: "#f3e2a6",
  border: "#b9a67f",
  tile: "#efe5cb",
  accentWarm: "#8f2916",
  onAccent: "#ffffff",
  onInk: "#f6eeda",
  shadowRgb: "42, 32, 22",
  highlight: "#8f2916",
  accent: "#8f2916",
  ...status(false),
};

export const retroCatalogue = exemplar(
  exemplarMeta({
    id: GANA,
    name: "Ganapati Provisions",
    description:
      "A retro printed catalogue: a paper-coloured page, a utility bar above the brand row, framed cards, a ruled comparison table and a price-list feel.",
    direction: "retro-catalogue",
    engine: "storefront-editorial",
    industries: ["food-and-drink", "general"],
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
    keywords: ["retro", "catalogue", "provisions", "price list"],
    previewImage: ganaPic("preview"),
    screenshotAlt:
      "Ganapati Provisions homepage with a ruled list of departments",
  }),
  "retro-catalogue",
  {
    brand: {
      primaryColor: "#8f2916",
      tagline: "Provisions of quality, priced by the week",
      blurb:
        "A family provision store with its price list online: staples by weight, produce by the day and dairy from the same two farms every morning.",
    },
    announcement: {
      text: "This week's price list is in force until Sunday",
      href: "/how-we-source",
    },
    design: {
      palette: ganaPalette,
      fonts: { body: DESIGN_FONTS.lora, display: DESIGN_FONTS.marcellus },
      shape: { card: "4px", control: "2px", sm: "2px", pill: "999px" },
      layout: {
        header: "utility",
        card: "framed",
        productDetail: "classic",
        cart: "classic",
        footer: "rich",
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 4,
        shopFilters: true,
        collectionBanner: false,
        cardHoverImage: false,
      },
      typography: {
        headingFont: "display",
        headingScale: "medium",
        headingWeight: "regular",
        headingCase: "uppercase",
        headingTracking: "wide",
      },
      buttons: {
        shape: "square",
        primary: "solid",
        secondary: "outline",
        case: "uppercase",
        weight: "semibold",
        tracking: "wide",
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
          { type: "delivery_estimate" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "trust_row",
            items: [
              { icon: "badge-check", label: "Weighed at the counter" },
              { icon: "truck", label: "Delivered the same day" },
              { icon: "refresh", label: "Replaced if not right" },
            ],
          },
          { type: "description" },
          { type: "reviews" },
          { type: "recommendations" },
          { type: "sticky_bar" },
        ],
      },
      collection: { filters: "sidebar", pagination: "paged", promoTiles: [] },
      blog: { index: "grid", article: "sidebar" },
      account: { layout: "tabs", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "A family provision store's price list online: staples by weight, fresh produce daily and dairy from two farms.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                slide(
                  "Provisions of quality",
                  "Staples by weight, produce by the day, dairy by the morning.",
                  "See the price list",
                  "/shop",
                  ganaPic("hero"),
                  "#2a2016",
                ),
                slide(
                  "The noodle counter",
                  "Fresh hakka noodles, cut every morning at seven.",
                  "Shop staples",
                  "/collections/staples",
                  ganaPic("banner-noodles"),
                  "#8f2916",
                ),
              ],
              height: "large",
              autoplay: true,
              interval_seconds: 7,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "departments",
            "shop_by_category",
            {
              heading: "Departments",
              subheading: "As listed in the catalogue",
              source: "all",
              category_ids: [],
              layout: "grid",
              display: "list",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "grades",
            "comparison",
            {
              heading: "Three grades of rice",
              subheading: "Priced per kilo, weighed at the counter",
              columns: [
                {
                  label: "Daily",
                  caption: "For the pressure cooker",
                  cta_label: "Order daily",
                  cta_href: "/shop/basmati-rice",
                  highlight: false,
                },
                {
                  label: "Reserve",
                  caption: "Aged one year",
                  cta_label: "Order reserve",
                  cta_href: "/shop/basmati-rice",
                  highlight: true,
                },
                {
                  label: "Festival",
                  caption: "Aged two years",
                  cta_label: "Order festival",
                  cta_href: "/shop/basmati-rice",
                  highlight: false,
                },
              ],
              rows: [
                {
                  type: "text",
                  label: "Grain length",
                  values: ["6.8 mm", "7.4 mm", "8.1 mm"],
                },
                {
                  type: "check",
                  label: "Suited to biryani",
                  values: ["no", "yes", "yes"],
                },
                {
                  type: "text",
                  label: "Sold in",
                  values: ["1, 5, 25 kg", "1, 5 kg", "1 kg"],
                },
              ],
              style: "table",
            },
            { scheme: "soft", padding_y: "md", width: "contained" },
          ),
          section(
            "counter",
            "product_spotlight",
            {
              eyebrow: "From the counter",
              heading: "",
              body: "Baked at five, on the shelf by seven, and usually gone by noon. Reserve a loaf the night before.",
              source: "featured",
              product_id: null,
              media_position: "right",
              cta_label: "Reserve one",
              show_price: true,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "list",
            "featured_products",
            {
              heading: "This week's list",
              subheading: "Prices in force until Sunday",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 8,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "questions",
            "faq_accordion",
            {
              heading: "Ordering from the list",
              subheading: "",
              items: [
                {
                  question: "Do prices change during the week?",
                  answer:
                    "No. The list is set on Monday morning and holds until Sunday night.",
                  category: "Prices",
                },
                {
                  question: "Can I order by weight?",
                  answer:
                    "Yes. Staples are sold loose from 250 g, weighed at the counter and packed in paper.",
                  category: "Orders",
                },
              ],
              show_filters: false,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "signup",
            "newsletter",
            signup(
              "The Monday list",
              "The week's prices, sent as soon as they are set.",
              "Send the list",
              "Ganapati Provisions",
              "light",
            ),
            { scheme: "accent", padding_y: "md", width: "full" },
          ),
        ],
      },
      {
        slug: "how-we-source",
        title: "How We Source",
        seo_description:
          "Where Ganapati Provisions buys its staples, produce and dairy, and how the weekly price list is set.",
        sections: [
          section("source-text", "rich_text", {
            html: "<h2>How we source</h2><p>Rice comes from one mill in Karnal, pulses from two traders in Indore, and milk from the same two farms each morning. Prices are set on Monday from what the market closed at on Saturday.</p>",
            width: "contained",
          }),
          section("source-rows", "accordion", {
            heading: "By department",
            subheading: "",
            items: [
              {
                type: "text",
                heading: "Staples",
                body: "Bought by the sack, cleaned in the shop and sold loose or in paper bags.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Produce",
                body: "Collected from the wholesale market before six each morning. Nothing is kept overnight.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: true,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Price list", href: "/shop" },
        { label: "Staples", href: "/collections/staples" },
        { label: "Produce", href: "/collections/fruits-vegetables" },
        { label: "Dairy", href: "/collections/dairy-eggs" },
        { label: "How we source", href: "/how-we-source" },
      ],
      footerGroups: [
        {
          title: "Departments",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Snacks", href: "/collections/snacks-beverages" },
            { label: "Household", href: "/collections/household" },
          ],
        },
        {
          title: "The store",
          links: [
            { label: "How we source", href: "/how-we-source" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: legal,
    },
    stylesheet: EXEMPLAR_STYLESHEETS["retro-catalogue"],
    sampleData: catalogueOf(basket, GANA),
  },
);

// ── Tech spec: "Lumen Works" ───────────────────────────────────────────────
// Lighting sold on its numbers: a dark page with one signal colour, a
// utility header, a grid gallery, hotspots on the product and a spec table.
const LUMEN = "exemplar-tech-spec";
const lumenPic = (name: string) => img(LUMEN, name);
const lumenPalette: ThemePalette = {
  cream: "#0d1317",
  creamDeep: "#131b20",
  surface: "#161f25",
  ink: "#e7edf1",
  inkSoft: "#aab7c0",
  inkFaint: "#6f7d87",
  taupe: "#1c262d",
  sand: "#18222a",
  butter: "#1f2a22",
  border: "#2a3741",
  tile: "#121a1f",
  accentWarm: "#35d0ba",
  onAccent: "#06100f",
  onInk: "#0d1317",
  shadowRgb: "0, 0, 0",
  highlight: "#35d0ba",
  accent: "#35d0ba",
  ...status(true),
};

export const techSpec = exemplar(
  exemplarMeta({
    id: LUMEN,
    name: "Lumen Works",
    description:
      "Tech spec: a dark page with one signal colour, a utility header, hotspots on the product, a specification table and accordions for the detail.",
    direction: "tech-spec",
    engine: "storefront-editorial",
    industries: ["electronics", "home"],
    catalogSizes: ["small", "medium"],
    features: [
      "advanced-search",
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["tech", "specification", "lighting", "engineered"],
    previewImage: lumenPic("preview"),
    screenshotAlt:
      "Lumen Works homepage, a dark page with a lamp and its specs",
  }),
  "tech-spec",
  {
    brand: {
      primaryColor: "#35d0ba",
      tagline: "Light, measured",
      blurb:
        "Lamps and objects engineered in Bengaluru and sold on their numbers: lumens, colour rendering, watts and a five-year driver warranty.",
    },
    announcement: {
      text: "Every lamp ships with its own measured test sheet",
      href: "/specifications",
    },
    design: {
      palette: lumenPalette,
      fonts: { body: DESIGN_FONTS.inter, display: DESIGN_FONTS.sora },
      shape: { card: "4px", control: "4px", sm: "2px", pill: "4px" },
      layout: {
        header: "utility",
        card: "classic",
        productDetail: "stacked",
        cart: "compact",
        footer: "compact",
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 4,
        shopFilters: true,
        collectionBanner: false,
        cardHoverImage: false,
      },
      typography: {
        headingFont: "display",
        headingScale: "medium",
        headingWeight: "semibold",
        headingCase: "none",
        headingTracking: "tight",
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
      page: { width: "wide", sectionGap: "compact", gridGap: "tight" },
      motion: { reveal: "fade" },
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
              { icon: "shield", label: "Five-year driver warranty" },
              { icon: "badge-check", label: "Measured test sheet included" },
              { icon: "truck", label: "Ships in two days" },
            ],
          },
          {
            type: "accordion",
            rows: [
              {
                heading: "Output",
                body: "820 lumens at 2700 K, colour rendering index 95, flicker under one per cent at every dimming level.",
              },
              {
                heading: "Power",
                body: "9 W at full output from a replaceable driver. USB-C input, 2 m braided cable included.",
              },
            ],
          },
          { type: "description" },
          { type: "reviews" },
          { type: "recommendations" },
          { type: "sticky_bar" },
        ],
      },
      collection: {
        filters: "top-bar",
        pagination: "load-more",
        promoTiles: [],
      },
      blog: { index: "grid", article: "wide" },
      account: { layout: "sidebar", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Lamps engineered in Bengaluru and sold on their numbers, each shipped with a measured test sheet and a five-year warranty.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                slide(
                  "Light, measured",
                  "820 lumens, CRI 95, flicker under one per cent.",
                  "See the range",
                  "/shop",
                  lumenPic("hero"),
                  "#0d1317",
                ),
                slide(
                  "The desk lamp, revision four",
                  "A new driver, a longer arm, the same nine watts.",
                  "Shop lighting",
                  "/collections/lighting",
                  lumenPic("lamp"),
                  "#131b20",
                ),
              ],
              height: "large",
              autoplay: false,
              interval_seconds: 8,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "numbers",
            "usp_bar",
            {
              theme: "dark",
              items: [
                {
                  icon: "sparkles",
                  title: "CRI 95",
                  subtitle: "Colour as it is",
                },
                {
                  icon: "shield",
                  title: "Five years",
                  subtitle: "Driver warranty",
                },
                {
                  icon: "badge-check",
                  title: "Test sheet",
                  subtitle: "Measured per lamp",
                },
                { icon: "truck", title: "Two days", subtitle: "To dispatch" },
              ],
            },
            { scheme: "soft", padding_y: "sm", width: "full" },
          ),
          section(
            "anatomy",
            "image_hotspots",
            {
              eyebrow: "Anatomy",
              heading: "What is inside the lamp",
              subheading: "Select a point to read the part.",
              image_url: lumenPic("lamp"),
              image_alt: "A table lamp with a ceramic base and a linen shade",
              image_ratio: "landscape",
              hotspots: [
                {
                  x: 50,
                  y: 28,
                  title: "Emitter",
                  body: "A single 2700 K array behind a frosted diffuser.",
                  href: "/shop/earth-table-lamp",
                  cta_label: "See the lamp",
                },
                {
                  x: 48,
                  y: 72,
                  title: "Driver",
                  body: "Replaceable, flicker-free, rated for fifty thousand hours.",
                  href: "/specifications",
                  cta_label: "Read the spec",
                },
              ],
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "compare",
            "comparison",
            {
              heading: "Compare",
              subheading: "The three lamps, side by side",
              columns: [
                {
                  label: "Desk",
                  caption: "Task light",
                  cta_label: "Shop desk",
                  cta_href: "/collections/lighting",
                  highlight: true,
                },
                {
                  label: "Table",
                  caption: "Room light",
                  cta_label: "Shop table",
                  cta_href: "/shop/earth-table-lamp",
                  highlight: false,
                },
                {
                  label: "Floor",
                  caption: "Reading light",
                  cta_label: "Shop floor",
                  cta_href: "/collections/lighting",
                  highlight: false,
                },
              ],
              rows: [
                {
                  type: "text",
                  label: "Output",
                  values: ["820 lm", "1100 lm", "1600 lm"],
                },
                {
                  type: "text",
                  label: "Power",
                  values: ["9 W", "12 W", "18 W"],
                },
                {
                  type: "check",
                  label: "Dimmable",
                  values: ["yes", "yes", "yes"],
                },
                {
                  type: "check",
                  label: "USB-C powered",
                  values: ["yes", "no", "no"],
                },
              ],
              style: "table",
            },
            { scheme: "soft", padding_y: "md", width: "contained" },
          ),
          section(
            "range",
            "featured_products",
            {
              heading: "The range",
              subheading: "",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 8,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "signup",
            "newsletter",
            signup(
              "Revision notes",
              "What changed in each revision, and why.",
              "Subscribe",
              "Lumen Works",
              "dark",
              "left",
            ),
            { scheme: "inverse", padding_y: "md", width: "full" },
          ),
        ],
      },
      {
        slug: "specifications",
        title: "Specifications",
        seo_description:
          "How Lumen Works measures every lamp: lumens, colour rendering, flicker and the test sheet shipped in each box.",
        sections: [
          section("spec-text", "rich_text", {
            html: "<h2>Specifications</h2><p>Every lamp is measured in an integrating sphere before it is boxed. The sheet in the box is that lamp's own result, not a typical figure.</p>",
            width: "contained",
          }),
          section("spec-rows", "accordion", {
            heading: "What we measure",
            subheading: "",
            items: [
              {
                type: "text",
                heading: "Colour rendering",
                body: "CRI and R9 at full output and at ten per cent. A lamp under CRI 93 is not shipped.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Flicker",
                body: "Percent flicker and frequency at five dimming levels, on the driver the lamp ships with.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: true,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Range", href: "/shop" },
        { label: "Lighting", href: "/collections/lighting" },
        { label: "Objects", href: "/collections/objects" },
        { label: "Specifications", href: "/specifications" },
      ],
      footerGroups: [
        {
          title: "Range",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Seating", href: "/collections/seating" },
          ],
        },
        {
          title: "Support",
          links: [
            { label: "Specifications", href: "/specifications" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: legal,
    },
    stylesheet: EXEMPLAR_STYLESHEETS["tech-spec"],
    sampleData: catalogueOf(studio, LUMEN),
  },
);

// ── Artisan craft: "Mitti & Marigold" ──────────────────────────────────────
// A small maker's shop: a clay-coloured page, a centred header, names under
// tall photographs, the maker's story beside the goods, one before and after.
const MITTI = "exemplar-artisan-craft";
const mittiPic = (name: string) => img(MITTI, name);
const mittiPalette: ThemePalette = {
  cream: "#d8cdbb",
  creamDeep: "#cdc1ac",
  surface: "#efe8da",
  ink: "#2d231b",
  inkSoft: "#4e4034",
  inkFaint: "#8b7b6a",
  taupe: "#c9bca4",
  sand: "#d2c6b0",
  butter: "#ead9a9",
  border: "#b3a58e",
  tile: "#e6dece",
  accentWarm: "#6f4226",
  onAccent: "#ffffff",
  onInk: "#efe8da",
  shadowRgb: "45, 35, 27",
  highlight: "#6f4226",
  accent: "#6f4226",
  ...status(false),
  // The stock red reads at 4.16:1 on clay; a sale price needs 4.5:1.
  error: "#9a1a14",
};

export const artisanCraft = exemplar(
  exemplarMeta({
    id: MITTI,
    name: "Mitti & Marigold",
    description:
      "Artisan craft: a clay-coloured page, a centred header, names under tall photographs, the maker's story beside the goods and a before and after.",
    direction: "artisan-craft",
    engine: "storefront-editorial",
    industries: ["wellness", "art"],
    catalogSizes: ["one-product", "small"],
    features: [
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["artisan", "craft", "handmade", "small batch"],
    previewImage: mittiPic("preview"),
    screenshotAlt: "Mitti & Marigold homepage on a clay-coloured page",
  }),
  "artisan-craft",
  {
    brand: {
      primaryColor: "#6f4226",
      tagline: "Made by four hands in Auroville",
      blurb:
        "Soaps, oils and balms made in batches of sixty by two people, from plants grown within a morning's cycle ride of the workshop.",
    },
    announcement: {
      text: "This batch was poured on the first of the month",
      href: "/the-workshop",
    },
    design: {
      palette: mittiPalette,
      fonts: { body: DESIGN_FONTS.workSans, display: DESIGN_FONTS.ebGaramond },
      shape: { card: "14px", control: "10px", sm: "6px", pill: "999px" },
      layout: {
        header: "centered",
        card: "centered",
        productDetail: "editorial",
        cart: "classic",
        footer: "centered",
        stickyAddToCart: false,
        gridColumnsMobile: 1,
        gridColumnsDesktop: 3,
        shopFilters: true,
        collectionBanner: true,
        cardHoverImage: false,
      },
      typography: {
        headingFont: "display",
        headingScale: "large",
        headingWeight: "regular",
        headingCase: "none",
        headingTracking: "normal",
      },
      buttons: {
        shape: "rounded",
        primary: "solid",
        secondary: "text",
        case: "none",
        weight: "medium",
        tracking: "normal",
        hover: "darken",
      },
      page: { width: "narrow", sectionGap: "airy", gridGap: "roomy" },
      motion: { reveal: "fade" },
    },
    templates: {
      product: {
        gallery: "thumbs-bottom",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          { type: "description" },
          {
            type: "accordion",
            rows: [
              {
                heading: "What is in it",
                body: "Cold-pressed coconut and sesame oils, beeswax from one keeper, and plants we dry ourselves. The full list is on the tin.",
              },
              {
                heading: "How long it keeps",
                body: "Six months from the batch date stamped underneath, away from sun and steam.",
              },
            ],
          },
          { type: "share" },
          { type: "reviews" },
          { type: "recommendations" },
        ],
      },
      collection: {
        filters: "drawer",
        pagination: "load-more",
        promoTiles: [],
      },
      blog: { index: "featured", article: "narrow" },
      account: { layout: "plain", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Soaps, oils and balms made in batches of sixty by two people in Auroville, from plants grown close to the workshop.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                slide(
                  "Made by four hands",
                  "Batches of sixty, poured on the first of each month.",
                  "See this batch",
                  "/shop",
                  mittiPic("hero"),
                  "#6f4226",
                ),
                slide(
                  "The evening oil",
                  "Sesame, vetiver and a week of sun in a clay pot.",
                  "Shop body",
                  "/collections/body",
                  mittiPic("body-oil"),
                  "#2d231b",
                ),
              ],
              height: "large",
              autoplay: false,
              interval_seconds: 8,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "makers",
            "media_text",
            {
              eyebrow: "The makers",
              heading: "Two people, one stove",
              body: "Anu grows and dries the plants; Felix cooks and pours. A batch takes four days and neither of us has found a way to hurry it.",
              cta_label: "Visit the workshop",
              cta_href: "/the-workshop",
              image_url: mittiPic("cleanser"),
              image_alt: "A bottle of botanical cleanser on a clay shelf",
              media_position: "left",
              media_ratio: "portrait",
              alignment: "left",
              stories: [
                {
                  eyebrow: "Plants",
                  heading: "Grown a cycle ride away",
                  body: "Vetiver, tulsi and marigold from three small plots, picked the morning they are used.",
                  cta_label: "",
                  cta_href: "",
                  image_url: mittiPic("bath-soak"),
                  image_alt: "A jar of mineral bath soak with dried petals",
                  media_position: "right",
                },
              ],
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "cure",
            "before_after",
            {
              eyebrow: "Four weeks on a shelf",
              heading: "Before and after the cure",
              subheading:
                "Drag across to see what a month of drying does to a bar.",
              before: {
                image_url: mittiPic("moisturizer"),
                image_alt: "A freshly poured jar of cream, still glossy",
                label: "Day one",
              },
              after: {
                image_url: mittiPic("candle"),
                image_alt: "A cured candle in a tumbler, matte and firm",
                label: "Week four",
              },
              image_ratio: "landscape",
              start: 50,
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "shelves",
            "shop_by_category",
            {
              heading: "On the shelves",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "scroll",
              display: "circles",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "batch",
            "featured_products",
            {
              heading: "This month's batch",
              subheading: "Sixty of each, then we start again",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 6,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "notes",
            "testimonials",
            {
              eyebrow: "",
              heading: "Notes people sent back",
              subheading: "",
              items: [
                {
                  quote:
                    "The tin had the batch date written by hand. I have kept the tin.",
                  author: "Leela S.",
                  detail: "Chennai",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote:
                    "It smells like the garden it came from, and nothing else.",
                  author: "Tom B.",
                  detail: "Pondicherry",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote: "I wrote to ask about the beeswax and Anu wrote back.",
                  author: "Farah M.",
                  detail: "Bengaluru",
                  logo_url: "",
                  logo_alt: "",
                },
              ],
              layout: "cards",
              columns: 3,
            },
            { scheme: "tint", padding_y: "lg", width: "contained" },
          ),
          section(
            "signup",
            "newsletter",
            signup(
              "A note on the first",
              "What we poured this month and what is nearly gone.",
              "Send me the note",
              "Mitti & Marigold",
              "light",
            ),
            { padding_y: "lg", width: "contained" },
          ),
        ],
      },
      {
        slug: "the-workshop",
        title: "The Workshop",
        seo_description:
          "The two-person workshop in Auroville where Mitti & Marigold grows, dries, cooks and pours each batch of sixty.",
        sections: [
          section("workshop-text", "rich_text", {
            html: "<h2>The workshop</h2><p>One room, one stove, a drying loft and a shelf that holds exactly sixty tins. Plants come in on Monday, are dried by Thursday, cooked on Friday and poured on the first.</p>",
            width: "contained",
          }),
          section("workshop-rows", "accordion", {
            heading: "A batch, day by day",
            subheading: "",
            items: [
              {
                type: "text",
                heading: "Days one to three",
                body: "Picking and drying. Nothing is used fresh; water is what makes a balm spoil.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Day four",
                body: "Cooking in oil over a low flame for six hours, then straining through muslin and pouring.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: true,
          }),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop" },
        { label: "Face", href: "/collections/face" },
        { label: "Body", href: "/collections/body" },
        { label: "The workshop", href: "/the-workshop" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "This batch", href: "/shop" },
            { label: "Home", href: "/collections/home" },
          ],
        },
        {
          title: "Us",
          links: [
            { label: "The workshop", href: "/the-workshop" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: legal,
    },
    stylesheet: EXEMPLAR_STYLESHEETS["artisan-craft"],
    sampleData: catalogueOf(ritual, MITTI),
  },
);

/** The seven later directions' exemplars, in the directions' own order. */
export const LATER_EXEMPLARS = [
  brutalist,
  scandinavianUtility,
  maximalPattern,
  darkLuxury,
  retroCatalogue,
  techSpec,
  artisanCraft,
] as const;
