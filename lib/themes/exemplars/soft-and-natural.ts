// Soft and natural — "Ila Botanicals": a skin and bathing brand on a sage
// page. Rounded corners, pill buttons, circular scrolling categories, a
// stacked header, soft cards, ingredient stories, a before/after and an
// accordion with pictures. Ritual's imagery and catalogue.
import { DESIGN_FONTS } from "../fonts";
import { ritual } from "../definitions/ritual";
import { catalogueOf, exemplar, exemplarMeta, img, section } from "./shared";

const ID = "exemplar-soft-and-natural";
const pic = (name: string) => img(ID, name);
const catalogue = catalogueOf(ritual, ID);

export const softAndNatural = exemplar(
  exemplarMeta({
    id: ID,
    name: "Ila Botanicals",
    description:
      "A soft, natural skin and bathing brand on a sage page: pill controls, circular categories, ingredient stories and a before-and-after.",
    direction: "soft-and-natural",
    engine: "storefront-editorial",
    industries: ["beauty", "wellness"],
    catalogSizes: ["small"],
    features: [
      "blogs",
      "cart-drawer",
      "category-navigation",
      "faq",
      "product-filtering",
      "product-recommendations",
      "variant-picker",
    ],
    keywords: ["botanical", "skin", "bath", "natural", "sage"],
    previewImage: pic("preview"),
    screenshotAlt: "Ila Botanicals homepage on a sage-green page",
  }),
  "soft-and-natural",
  {
    brand: {
      primaryColor: "#4f6b55",
      tagline: "Slow formulas for unhurried skin",
      blurb:
        "Cleansers, oils and bathing care made in small batches from plants we can name, in a workshop above a garden in Coorg, for skin that would rather be left alone.",
    },
    announcement: {
      text: "Free delivery on orders over ₹1,499 and a sample with every order",
    },
    design: {
      palette: {
        cream: "#eef1ea",
        creamDeep: "#e1e6dc",
        surface: "#f7f9f4",
        ink: "#243127",
        inkSoft: "#4a5a4e",
        inkFaint: "#7f8c82",
        taupe: "#d8ddd2",
        sand: "#e4e8df",
        butter: "#ece6d2",
        border: "#cfd6cb",
        tile: "#e4e8df",
        accentWarm: "#9a6b4f",
        onAccent: "#ffffff",
        onInk: "#f3f6ef",
        shadowRgb: "36, 49, 39",
        success: "#2f6b4f",
        successSoft: "#dfeee4",
        error: "#a8321f",
        errorSoft: "#f4e3df",
        star: "#9a6b4f",
        highlight: "#4f6b55",
        accent: "#4f6b55",
      },
      fonts: {
        body: DESIGN_FONTS.jakarta,
        display: DESIGN_FONTS.outfit,
      },
      shape: { card: "20px", control: "14px", sm: "12px", pill: "999px" },
      layout: {
        header: "stacked",
        card: "soft",
        productDetail: "classic",
        cart: "compact",
        footer: "centered",
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 4,
        shopFilters: true,
        collectionBanner: false,
      },
      typography: {
        headingFont: "display",
        headingScale: "medium",
        headingWeight: "semibold",
        headingCase: "none",
        headingTracking: "normal",
      },
      buttons: {
        shape: "pill",
        primary: "solid",
        secondary: "outline",
        case: "none",
        weight: "medium",
        tracking: "normal",
        hover: "lift",
      },
      page: { width: "standard", sectionGap: "standard", gridGap: "standard" },
      motion: { reveal: "none" },
    },
    templates: {
      product: {
        gallery: "thumbs-left",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "trust_row",
            items: [
              { icon: "leaf", label: "Plants we can name" },
              { icon: "heart", label: "Never tested on animals" },
              { icon: "refresh", label: "Thirty-day returns" },
            ],
          },
          {
            type: "accordion",
            rows: [
              {
                heading: "How to use",
                body: "Warm a few drops between your palms and press into damp skin, morning and night.",
              },
              {
                heading: "Ingredients",
                body: "Every ingredient is listed in full on the carton and on this page, by its plant name and its INCI name.",
              },
              {
                heading: "Shelf life",
                body: "Twelve months unopened, six once opened. The batch date is printed on the base.",
              },
            ],
          },
          { type: "description" },
          {
            type: "rich_text",
            html: "<p>Made in batches of two hundred in our Coorg workshop. If a batch is sold out, the next is usually a fortnight away.</p>",
          },
          { type: "reviews" },
          { type: "recommendations" },
          { type: "sticky_bar" },
        ],
      },
      collection: {
        filters: "drawer",
        pagination: "load-more",
        promoTiles: [
          {
            afterIndex: 4,
            heading: "Start with the ritual",
            body: "Cleanser, serum and cream in the order your skin wants them.",
            cta_label: "Read how",
            href: "/our-ingredients",
            image_url: "",
            image_alt: "",
            theme: "dark",
            background: "#e1e6dc",
          },
        ],
      },
      blog: { index: "featured", article: "sidebar" },
      account: { layout: "tabs", scheme: "soft" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seo_description:
          "Small-batch cleansers, oils and bathing care from a workshop above a garden in Coorg, made from plants we can name.",
        sections: [
          section(
            "opening",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Slow formulas for unhurried skin",
                  subheading:
                    "Made in batches of two hundred above a garden in Coorg.",
                  cta_label: "Shop the range",
                  cta_href: "/shop",
                  image_url: pic("hero"),
                  video_url: "",
                  background: "#e1e6dc",
                  theme: "dark",
                },
                {
                  heading: "The evening soak",
                  subheading:
                    "Mineral salts, lavender and twenty quiet minutes.",
                  cta_label: "Shop body",
                  cta_href: "/collections/body",
                  image_url: pic("bath-soak"),
                  video_url: "",
                  background: "#e1e6dc",
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
            "ranges",
            "shop_by_category",
            {
              heading: "Shop by ritual",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "scroll",
              display: "circles",
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "garden",
            "media_text",
            {
              eyebrow: "The garden",
              heading: "Plants we can name",
              body: "Every formula starts in the garden under the workshop: calendula for the cleanser, rosehip for the serum, lavender for the soak. What we cannot grow, we buy from two farms within the district.",
              cta_label: "Our ingredients",
              cta_href: "/our-ingredients",
              image_url: pic("serum"),
              image_alt:
                "A glass dropper bottle of facial serum on a stone ledge",
              media_position: "left",
              media_ratio: "landscape",
              alignment: "left",
              stories: [
                {
                  eyebrow: "Morning",
                  heading: "A cleanser that leaves something behind",
                  body: "Calendula and oat, so skin is cleaned without being stripped. Rinse, press dry, and that is the whole step.",
                  cta_label: "Shop face",
                  cta_href: "/collections/face",
                  image_url: pic("cleanser"),
                  image_alt:
                    "A tube of botanical cleanser beside a linen cloth",
                  media_position: "right",
                },
                {
                  eyebrow: "Evening",
                  heading: "Oil, then stillness",
                  body: "The body oil is pressed into warm skin after a soak, which is when it does the most and asks the least.",
                  cta_label: "Shop body",
                  cta_href: "/collections/body",
                  image_url: pic("body-oil"),
                  image_alt: "A bottle of body oil on a folded towel",
                  media_position: "left",
                },
              ],
            },
            { padding_y: "lg", width: "contained" },
          ),
          section(
            "bestsellers",
            "featured_products",
            {
              heading: "Most loved",
              subheading: "The six that leave the workshop fastest",
              source: "featured",
              product_ids: [],
              category_id: null,
              limit: 6,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "weeks",
            "before_after",
            {
              eyebrow: "Two weeks",
              heading: "The same morning, a fortnight apart",
              subheading:
                "A customer's bathroom shelf before the ritual and after it. Drag to compare.",
              before: {
                image_url: pic("cleanser"),
                image_alt: "A bathroom shelf with one cleanser",
                label: "Day one",
              },
              after: {
                image_url: pic("moisturizer"),
                image_alt: "The same shelf with the cleanser, serum and cream",
                label: "Day fourteen",
              },
              image_ratio: "landscape",
              start: 45,
            },
            { scheme: "soft", padding_y: "lg", width: "contained" },
          ),
          section(
            "howto",
            "accordion",
            {
              heading: "How to use the ritual",
              subheading: "",
              items: [
                {
                  type: "image",
                  heading: "Cleanse",
                  body: "A pea-sized amount on damp skin, thirty seconds, rinse with warm water.",
                  image_url: pic("cleanser"),
                  image_alt: "A tube of cleanser on a stone ledge",
                },
                {
                  type: "image",
                  heading: "Treat",
                  body: "Three drops of serum pressed, not rubbed, into still-damp skin.",
                  image_url: pic("serum"),
                  image_alt: "A dropper bottle of serum",
                },
                {
                  type: "text",
                  heading: "Protect",
                  body: "A thin layer of the barrier cream to seal it in. Morning and night, no more than that.",
                  image_url: "",
                  image_alt: "",
                },
              ],
              open_first: true,
              allow_multiple: true,
            },
            { padding_y: "md", width: "contained" },
          ),
          section(
            "letters",
            "newsletter",
            {
              eyebrow: "From the garden",
              heading: "A note when a batch is ready",
              subheading:
                "Batch dates, what is in flower, and an early sample now and then.",
              button_label: "Subscribe",
              success_message:
                "Thank you. The next note comes with the next batch.",
              consent_text:
                "I agree to receive notes from Ila Botanicals by email.",
              theme: "dark",
              alignment: "center",
            },
            { padding_y: "lg", width: "contained" },
          ),
        ],
      },
      {
        slug: "our-ingredients",
        title: "Our Ingredients",
        seo_description:
          "Every plant in Ila Botanicals' formulas, where it grows and what it does, from calendula to lavender.",
        sections: [
          section(
            "ingredients-hero",
            "hero_carousel",
            {
              slides: [
                {
                  heading: "Calendula",
                  subheading:
                    "Grown under the workshop, picked at the end of the monsoon, infused in sunflower oil for six weeks.",
                  cta_label: "Shop face",
                  cta_href: "/collections/face",
                  image_url: pic("cleanser"),
                  video_url: "",
                  background: "#e1e6dc",
                  theme: "dark",
                },
                {
                  heading: "Lavender",
                  subheading:
                    "From a farm an hour up the valley, dried in the shade so the oil stays sweet.",
                  cta_label: "Shop body",
                  cta_href: "/collections/body",
                  image_url: pic("bath-soak"),
                  video_url: "",
                  background: "#e1e6dc",
                  theme: "dark",
                },
              ],
              layout: "split",
              height: "medium",
              autoplay: false,
              interval_seconds: 8,
            },
            { padding_y: "none", width: "full" },
          ),
          section("ingredients-cols", "multicolumn", {
            eyebrow: "What we leave out",
            heading: "Nothing you would not put on a child",
            subheading: "",
            items: [
              {
                icon: "leaf",
                image_url: "",
                image_alt: "",
                heading: "No synthetic fragrance",
                body: "Scent comes from the plant oils already in the formula, or there is none.",
                cta_label: "",
                cta_href: "",
              },
              {
                icon: "shield",
                image_url: "",
                image_alt: "",
                heading: "No mineral oil",
                body: "Sunflower, rosehip and jojoba, pressed within the state.",
                cta_label: "",
                cta_href: "",
              },
              {
                icon: "heart",
                image_url: "",
                image_alt: "",
                heading: "Never tested on animals",
                body: "Tested on us, our families and a patient group of volunteers in the village.",
                cta_label: "",
                cta_href: "",
              },
            ],
            columns: 3,
            alignment: "center",
            image_ratio: "square",
          }),
          section("ingredients-text", "rich_text", {
            html: "<h2>Reading a label</h2><p>Every carton lists each ingredient twice: by the plant we know it as, and by the INCI name a dermatologist would look for. If a name is unfamiliar, write to us and we will tell you where it came from and why it is there.</p>",
            width: "contained",
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
        { label: "Ingredients", href: "/our-ingredients" },
        { label: "Journal", href: "/blogs" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "Everything", href: "/shop" },
            { label: "Tools", href: "/collections/tools" },
          ],
        },
        {
          title: "About",
          links: [
            { label: "Our ingredients", href: "/our-ingredients" },
            { label: "Journal", href: "/blogs" },
            { label: "Enquiries", href: "/enquiries" },
          ],
        },
      ],
      footerLegal: [
        { label: "Privacy", href: "/privacy-policy" },
        { label: "Terms", href: "/terms" },
        { label: "Returns", href: "/refund-policy" },
      ],
    },
    sampleData: catalogue,
  },
);
