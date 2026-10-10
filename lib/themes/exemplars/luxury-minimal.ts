// Luxury minimal — "Maison Aurel": an accessories house. Airy, square,
// uppercase display type, outline controls, no motion, a quiet category
// title with the photography doing the work. Vitrine's imagery and catalogue.
import { DESIGN_FONTS } from "../fonts";
import { vitrine } from "../definitions/vitrine";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";

const ID = "exemplar-luxury-minimal";
const pic = (name: string) => img(ID, name);
const catalogue = catalogueOf(vitrine, ID);

export const luxuryMinimal = exemplar(
  exemplarMeta({
    id: ID,
    name: "Maison Aurel",
    description:
      "A luxury-minimal accessories house: airy pages, square corners, uppercase display type over quiet photography and outline controls.",
    direction: "luxury-minimal",
    engine: "storefront-editorial",
    industries: ["jewelry-and-accessories", "shoes"],
    catalogSizes: ["small", "medium"],
    features: [
      "cart-drawer",
      "category-navigation",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["luxury", "minimal", "accessories", "atelier"],
    previewImage: pic("preview"),
    screenshotAlt: "Maison Aurel homepage with a full-band photograph",
  }),
  "luxury-minimal",
  {
    brand: {
      primaryColor: "#1f1b19",
      tagline: "Pieces made slowly, worn for years",
      blurb:
        "A small accessories house in Jaipur: bags, belts and footwear cut from full-grain leather in an atelier of eleven, finished by hand and sold without a season's rush.",
    },
    announcement: {
      text: "Complimentary delivery and gift wrapping on every order",
      href: "/the-atelier",
    },
    design: {
      palette: {
        cream: "#fbfaf8",
        creamDeep: "#f1eeea",
        surface: "#ffffff",
        ink: "#1f1b19",
        inkSoft: "#5c5450",
        inkFaint: "#9c928b",
        taupe: "#e4ded6",
        sand: "#efebe6",
        butter: "#e8dcc8",
        border: "#ddd6cf",
        tile: "#efebe6",
        accentWarm: "#8c6f63",
        onAccent: "#ffffff",
        onInk: "#ffffff",
        shadowRgb: "31, 27, 25",
        success: "#2f6b4f",
        successSoft: "#e6f0ea",
        error: "#b80f27",
        errorSoft: "#faebee",
        star: "#1f1b19",
        highlight: "#b80f27",
      },
      fonts: {
        body: DESIGN_FONTS.jost,
        display: DESIGN_FONTS.bodoniModa,
      },
      shape: { card: "0px", control: "0px", sm: "0px", pill: "0px" },
      layout: {
        header: "minimal",
        card: "framed",
        productDetail: "editorial",
        cart: "compact",
        footer: "minimal",
        stickyAddToCart: true,
        gridColumnsMobile: 1,
        gridColumnsDesktop: 3,
        shopFilters: true,
        collectionBanner: false,
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
        primary: "outline",
        secondary: "text",
        case: "uppercase",
        weight: "medium",
        tracking: "wide",
        hover: "invert",
      },
      page: { width: "narrow", sectionGap: "airy", gridGap: "roomy" },
      motion: { reveal: "none" },
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
                heading: "Materials",
                body: "Full-grain vegetable-tanned leather from a tannery we have worked with for nine years, solid brass hardware, cotton twill lining.",
              },
              {
                heading: "Care",
                body: "Wipe with a dry cloth. Condition twice a year with a neutral balm; keep away from direct heat and rain.",
              },
              {
                heading: "Delivery and returns",
                body: "Delivered in four to six working days, gift wrapped at no charge. Fourteen days to exchange an unworn piece.",
              },
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
        pagination: "paged",
        promoTiles: [
          {
            afterIndex: 6,
            heading: "The atelier",
            body: "Eleven makers, one floor, every piece finished by hand.",
            cta_label: "Read the story",
            href: "/the-atelier",
            image_url: "",
            image_alt: "",
            theme: "light",
            background: "#1f1b19",
          },
        ],
      },
      blog: { index: "list", article: "narrow" },
      account: { layout: "plain", scheme: "" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Bags, belts and footwear cut from full-grain leather and finished by hand in a small Jaipur atelier.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Made slowly",
                  subheading:
                    "Eleven makers, one floor, and a season that takes as long as it takes.",
                  cta_label: "Shop the house",
                  cta_href: "/shop",
                  image_url: pic("hero"),
                  video_url: "",
                  background: "#efebe6",
                  theme: "dark",
                },
                {
                  heading: "The structured tote",
                  subheading:
                    "Holds its shape on the tenth year the way it did on the first morning.",
                  cta_label: "See the bags",
                  cta_href: "/collections/handbags",
                  image_url: pic("tote"),
                  video_url: "",
                  background: "#e4ded6",
                  theme: "dark",
                },
              ],
              height: "large",
              autoplay: true,
              interval_seconds: 7,
            },
            { width: "full", padding_y: "none" },
          ),
          section(
            "rooms",
            "shop_by_category",
            {
              heading: "The four rooms",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "grid",
              display: "cards",
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "edit",
            "featured_products",
            {
              heading: "This season's edit",
              subheading: "Six pieces we would buy ourselves",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 6,
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "atelier",
            "media_text",
            {
              eyebrow: "The atelier",
              heading: "One floor, eleven hands",
              body: "Every piece is cut, stitched and burnished on one floor in Jaipur. Nothing is outsourced, and nothing leaves until the person who made it has signed the lining.",
              cta_label: "Visit the atelier",
              cta_href: "/the-atelier",
              image_url: pic("loafer"),
              image_alt: "A brown penny loafer on a pale stone floor",
              media_position: "left",
              media_ratio: "square",
              alignment: "left",
              stories: [
                {
                  eyebrow: "Leather",
                  heading: "Tanned with bark, not chrome",
                  body: "Our hides are vegetable tanned over six weeks, which is why they darken and soften rather than crack.",
                  cta_label: "",
                  cta_href: "",
                  image_url: pic("belt"),
                  image_alt: "A tan leather belt coiled on linen",
                  media_position: "right",
                },
                {
                  eyebrow: "Hardware",
                  heading: "Solid brass, unplated",
                  body: "Buckles and feet are cast in solid brass and left unplated, so they wear to a warm patina instead of flaking.",
                  cta_label: "",
                  cta_href: "",
                  image_url: pic("crossbody"),
                  image_alt: "A black crossbody bag with brass hardware",
                  media_position: "left",
                },
              ],
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "shoot",
            "image_marquee",
            {
              items: [
                {
                  image_url: pic("heel"),
                  image_alt: "A black block-heel sandal",
                  href: "/collections/womens-shoes",
                },
                {
                  image_url: pic("sneaker"),
                  image_alt: "A white leather low-top sneaker",
                  href: "/collections/mens-shoes",
                },
                {
                  image_url: pic("sunglasses"),
                  image_alt: "Tortoiseshell sunglasses on a stone shelf",
                  href: "/collections/accessories",
                },
                {
                  image_url: pic("boot"),
                  image_alt: "A black leather ankle boot",
                  href: "/collections/womens-shoes",
                },
              ],
              speed: "slow",
              size: "md",
              image_ratio: "square",
            },
            { padding_y: "md", width: "full" },
          ),
          section(
            "words",
            "testimonials",
            {
              eyebrow: "In their words",
              heading: "Worn, not kept",
              subheading: "",
              items: [
                {
                  quote:
                    "The tote has done four years of commuting and looks better than the day it came, which I did not believe a bag could do.",
                  author: "Rhea M.",
                  detail: "Mumbai",
                  logo_url: "",
                  logo_alt: "",
                },
                {
                  quote:
                    "I had the loafers resoled once and the atelier recognised the pair from the lining number.",
                  author: "Arjun S.",
                  detail: "Bengaluru",
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
            "letters",
            "newsletter",
            {
              eyebrow: "Letters",
              heading: "A note when something is ready",
              subheading:
                "Four or five letters a year: a new shape, a leather we have found, a day the atelier opens its doors.",
              button_label: "Subscribe",
              success_message: "Thank you. The next letter will find you.",
              consent_text:
                "I agree to receive letters from Maison Aurel by email.",
              theme: "dark",
              alignment: "center",
            },
            { padding_y: "lg", width: "contained" },
          ),
        ],
      },
      {
        slug: "the-atelier",
        title: "The Atelier",
        seo_description:
          "How Maison Aurel's bags and footwear are cut, stitched and finished by hand in Jaipur, and how to care for them.",
        sections: [
          section(
            "atelier-hero",
            "hero",
            {
              variant: "offset",
              height: "large",
              heading: "The atelier",
              subheading:
                "A converted print works in the old city, eleven benches, and the sound of a mallet from eight in the morning.",
              cta_label: "Shop the house",
              cta_href: "/shop",
              image_url: pic("hero"),
              video_url: "",
              badge_text: "",
              background: "#efebe6",
              theme: "dark",
              alignment: "left",
              content_position: "bottom",
            },
            { width: "full", padding_y: "none" },
          ),
          section("atelier-rows", "accordion", {
            heading: "What goes into a piece",
            subheading: "",
            items: [
              {
                type: "image",
                heading: "Cutting",
                body: "Each hide is laid out against the pattern by hand so the grain runs the same way across a pair.",
                image_url: pic("belt"),
                image_alt: "A coiled tan leather belt on linen",
              },
              {
                type: "text",
                heading: "Stitching",
                body: "Saddle stitched with waxed linen thread at seven stitches to the inch. A broken thread holds; the seam does not unravel.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "text",
                heading: "Finishing",
                body: "Edges are bevelled, dyed, burnished and dyed again. It is the slowest step and the one you notice first.",
                image_url: "",
                image_alt: "",
              },
            ],
            open_first: true,
            allow_multiple: false,
          }),
          section("atelier-text", "rich_text", {
            html: "<h2>Caring for leather</h2><p>Keep pieces out of direct sun and away from radiators. Wipe with a dry cloth after rain and let them dry slowly, stuffed with paper. Condition twice a year with a neutral balm, and bring anything that needs a repair back to us: we would rather mend a bag than sell a second one.</p>",
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
              label: "Footwear",
              href: "",
              children: [
                { label: "Women's shoes", href: "/collections/womens-shoes" },
                { label: "Men's shoes", href: "/collections/mens-shoes" },
              ],
            },
            {
              label: "Bags and more",
              href: "",
              children: [
                { label: "Handbags", href: "/collections/handbags" },
                { label: "Accessories", href: "/collections/accessories" },
              ],
            },
          ],
        },
        { label: "The atelier", href: "/the-atelier" },
      ],
      footerGroups: [
        {
          title: "House",
          links: [
            { label: "All pieces", href: "/shop" },
            { label: "The atelier", href: "/the-atelier" },
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
    sampleData: catalogue,
  },
);
