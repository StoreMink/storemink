/**
 * Four made-up shops for `npm run revamp:live-check`
 * (docs/mink-storefront-revamp.md, section 14: "Live").
 *
 * Each request is what Mink AI would have gathered in its interview, in the
 * shape `start_storefront_revamp` sends (`readRevampRequest` reads it), minus
 * the photo address, which only exists once `--setup` has stored the phone
 * photo in the store's Media Library.
 *
 * ★ THE SHOPS ARE CHOSEN TO BE AWKWARD. A mustard oil mill on Vitrine (a
 *   fashion theme) is the case the redesign exists for: nothing about the
 *   theme fits, so every page, photo and word has to change. The other three
 *   sit on a theme near their trade, which is the ordinary case.
 * ★ THE FACTS ARE WHAT THE MERCHANT SAYS, AND NOTHING A REGULATOR WOULD
 *   QUESTION. The copy checks only let a claim through when the merchant's
 *   own words back it (lib/mink/revamp/copy-checks.ts), so these are the
 *   evidence. The oil mill says "kachi ghani, cold pressed in our own mill"
 *   and never "pure", "organic" or "natural", anywhere, not even in `avoid`:
 *   the point is to see whether the redesign invents them. No skincare
 *   product promises to treat anything, and no jewellery piece names a purity
 *   or a hallmark.
 * ★ Pure data with no imports, so the check script, a test or a person can
 *   read it without loading anything.
 */

export interface RevampLiveSize {
  label: string;
  /** Rupees. */
  price: number;
  /** Rupees; at least the price, or left out. */
  mrp?: number;
}

export interface RevampLiveProduct {
  name: string;
  description: string;
  /** The category the merchant files it under: one of the shop's own creates. */
  categorySlug: string;
  sizes: RevampLiveSize[];
  photo: {
    /**
     * What the merchant's phone photo shows, for `--live`: the subject only.
     * The script adds the amateur phone look and the no-people rule.
     */
    scene: string;
    /**
     * A bundled theme photo (a path under public/) copied into the store's
     * Media Library as the phone photo when the run is offline.
     */
    bundled: string;
  };
}

export interface RevampLiveFixture {
  slug: string;
  storeName: string;
  /** The theme installed at setup, before the redesign. */
  themeId: string;
  /** Saved as the store's business address, which the snapshot reads. */
  place: { city: string; state: string };
  request: {
    brief: {
      business: string;
      look: string;
      audience: string;
      facts: string[];
      avoid: string;
      language: "English";
    };
    products: RevampLiveProduct[];
    /**
     * The category changes the merchant agreed to in the interview, in the
     * shape `start_storefront_revamp` sends them (every one confirmed).
     * ★ A theme category that does not fit is hidden and a new one is created,
     *   never renamed: an update keeps the category's address, so a renamed
     *   "Women's Shoes" would sell mustard oil at /collections/womens-shoes.
     */
    categories: RevampLiveCategoryChange[];
  };
}

export type RevampLiveCategoryChange =
  | { action: "hide"; slug: string; merchant_confirmed: true }
  | {
      action: "create";
      name: string;
      slug: string;
      description: string;
      new_photo: boolean;
      merchant_confirmed: true;
    }
  | {
      action: "update";
      slug: string;
      description: string;
      new_photo: boolean;
      merchant_confirmed: true;
    };

const hide = (slug: string): RevampLiveCategoryChange => ({
  action: "hide",
  slug,
  merchant_confirmed: true,
});
const create = (
  name: string,
  slug: string,
  description: string,
): RevampLiveCategoryChange => ({
  action: "create",
  name,
  slug,
  description,
  new_photo: true,
  merchant_confirmed: true,
});

export const REVAMP_LIVE_FIXTURES: readonly RevampLiveFixture[] = [
  {
    slug: "kesar-ghani",
    storeName: "Kesar Ghani",
    themeId: "vitrine",
    place: { city: "Alwar", state: "Rajasthan" },
    request: {
      brief: {
        business:
          "Kachi ghani mustard oil, cold pressed in our own mill in Alwar from mustard seed we buy from farms around the district. We sell bottles and tins for home kitchens across India.",
        look: "Warm and earthy, mustard yellow and deep brown, like the old mill itself. Plain and honest, not glossy.",
        audience:
          "Families who cook every day, and people from Rajasthan living in other cities who miss the oil from home.",
        facts: [
          "Kachi ghani, cold pressed in our own mill in Alwar.",
          "Our family has run the mill for three generations.",
          "We buy our mustard seed from farms in Alwar district.",
          "Every bottle is filled and sealed at the mill.",
          "Orders are packed at the mill and sent out within two working days.",
        ],
        avoid:
          "Health or medicinal claims, words the label cannot back up, and anything that looks like a big factory brand.",
        language: "English",
      },
      products: [
        {
          name: "Kachi Ghani Mustard Oil",
          categorySlug: "mustard-oil",
          description:
            "Cold pressed from black mustard seed in our mill in Alwar. Sharp and full of flavour, for tadka, pickles and everyday cooking.",
          sizes: [
            { label: "500 ml", price: 165 },
            { label: "1 L", price: 299, mrp: 340 },
            { label: "5 L tin", price: 1425, mrp: 1600 },
          ],
          photo: {
            scene:
              "a one-litre clear glass bottle of golden mustard oil with a plain metal cap, standing on a steel kitchen counter beside a small steel bowl of black mustard seeds",
            bundled: "/themes/ritual/body-oil.webp",
          },
        },
        {
          name: "Yellow Mustard Oil",
          categorySlug: "mustard-oil",
          description:
            "Pressed from yellow mustard seed in the same mill. Milder than our black seed oil, for people who like a softer taste.",
          sizes: [
            { label: "1 L", price: 329, mrp: 360 },
            { label: "2 L", price: 640 },
          ],
          photo: {
            scene:
              "two plain clear plastic bottles of light yellow mustard oil on a wooden shelf in a small shop, one bottle slightly behind the other",
            bundled: "/themes/basket/p-juice.webp",
          },
        },
        {
          name: "Festive Oil Gift Tin",
          categorySlug: "gift-tins",
          description:
            "Two one-litre bottles of our kachi ghani mustard oil in a printed tin, packed at the mill for gifting at Diwali and weddings.",
          sizes: [{ label: "2 x 1 L", price: 699, mrp: 780 }],
          photo: {
            scene:
              "a round metal gift tin with a plain mustard yellow lid, open on a cotton cloth with two small glass bottles of mustard oil inside",
            bundled: "/themes/ritual/serum.webp",
          },
        },
      ],
      categories: [
        hide("womens-shoes"),
        hide("mens-shoes"),
        hide("handbags"),
        hide("accessories"),
        create(
          "Mustard Oil",
          "mustard-oil",
          "Kachi ghani mustard oil in bottles and tins, cold pressed in our mill in Alwar.",
        ),
        create(
          "Gift Tins",
          "gift-tins",
          "Our mustard oil packed in printed tins for Diwali and weddings.",
        ),
      ],
    },
  },
  {
    slug: "crumb-and-co",
    storeName: "Crumb and Co",
    themeId: "basket",
    place: { city: "Pune", state: "Maharashtra" },
    request: {
      brief: {
        business:
          "A neighbourhood bakery in Aundh, Pune. We bake sourdough, croissants and cakes every morning and deliver within Pune.",
        look: "Friendly and warm, flour-dusted and cosy, with a little colour. A corner bakery, not a fancy patisserie.",
        audience:
          "Families and office workers in Aundh, Baner and Pashan who want fresh bread in the morning and a cake for birthdays.",
        facts: [
          "We bake every morning from 5 am in our Aundh kitchen.",
          "Our sourdough is fermented for 24 hours before it is baked.",
          "Every cake on our menu can be made eggless.",
          "We deliver within Pune city, and orders placed before 2 pm arrive the same day.",
        ],
        avoid:
          "Words like artisanal or gourmet, anything that sounds expensive, and health claims.",
        language: "English",
      },
      products: [
        {
          name: "Country Sourdough Loaf",
          categorySlug: "breads",
          description:
            "A crusty loaf with a soft, open crumb, fermented for 24 hours and baked every morning.",
          sizes: [
            { label: "Half loaf", price: 180 },
            { label: "Whole loaf", price: 320 },
          ],
          photo: {
            scene:
              "a round crusty sourdough loaf on a floured wooden board on a bakery counter, with a bread knife lying beside it",
            bundled: "/themes/basket/p-bread.webp",
          },
        },
        {
          name: "Butter Croissants",
          categorySlug: "pastries",
          description:
            "Flaky, golden croissants made with butter and baked fresh each morning.",
          sizes: [
            { label: "Box of 2", price: 190 },
            { label: "Box of 6", price: 540 },
          ],
          photo: {
            scene:
              "four golden butter croissants in an open brown paper box on a steel bakery table",
            bundled: "/themes/basket/p-cookies.webp",
          },
        },
        {
          name: "Eggless Chocolate Truffle Cake",
          categorySlug: "cakes",
          description:
            "Layers of soft chocolate sponge and dark chocolate truffle, made without eggs. Order a day ahead for a name on top.",
          sizes: [
            { label: "500 g", price: 650 },
            { label: "1 kg", price: 1200, mrp: 1300 },
          ],
          photo: {
            scene:
              "a round chocolate truffle cake with glossy dark icing on a white cake board, on a bakery counter, with one slice cut out",
            bundled: "/themes/basket/banner-cookies.webp",
          },
        },
      ],
      categories: [
        hide("fruits-vegetables"),
        hide("staples"),
        hide("dairy-eggs"),
        hide("snacks-beverages"),
        hide("household"),
        create(
          "Breads",
          "breads",
          "Sourdough and loaves baked every morning in our Aundh kitchen.",
        ),
        create(
          "Pastries",
          "pastries",
          "Croissants and morning pastries, fresh from the oven.",
        ),
        create(
          "Cakes",
          "cakes",
          "Birthday and celebration cakes, every one of them can be made eggless.",
        ),
      ],
    },
  },
  {
    slug: "tara-jewels",
    storeName: "Tara Jewels",
    themeId: "studio",
    place: { city: "Jaipur", state: "Rajasthan" },
    request: {
      brief: {
        business:
          "Handmade silver jewellery from our family workshop in Jaipur: jhumkas, anklets and rings, made to be worn every day.",
        look: "Elegant and quiet, plenty of white space, deep indigo with a touch of warm silver. Not flashy.",
        audience:
          "Women who want everyday silver jewellery with a traditional Rajasthani touch, and people buying gifts for them.",
        facts: [
          "Every piece is made by hand in our workshop near Johari Bazaar.",
          "We have made silver jewellery in Jaipur since 1987.",
          "Each piece comes in a cotton pouch with a care card.",
          "Rings can be resized once at no charge within 30 days.",
        ],
        avoid:
          "Gold or gemstone claims, purity or hallmark claims, and anything about investment value.",
        language: "English",
      },
      products: [
        {
          name: "Silver Jhumka Earrings",
          categorySlug: "earrings",
          description:
            "Bell-shaped jhumkas with small hanging beads, made by hand in our Jaipur workshop. Light enough to wear all day.",
          sizes: [
            { label: "Small", price: 1450 },
            { label: "Large", price: 2250 },
          ],
          photo: {
            scene:
              "a pair of handmade silver jhumka earrings lying on a folded indigo cotton cloth on a wooden table, seen from above",
            bundled: "/themes/vitrine/belt.webp",
          },
        },
        {
          name: "Ghungroo Anklets",
          categorySlug: "anklets",
          description:
            "A pair of silver anklets with small ghungroo bells that chime softly as you walk.",
          sizes: [{ label: "Pair", price: 2800, mrp: 3200 }],
          photo: {
            scene:
              "a pair of silver anklets with tiny bells laid out in a loose curve on a white marble surface",
            bundled: "/themes/vitrine/crossbody.webp",
          },
        },
        {
          name: "Hammered Silver Ring",
          categorySlug: "rings",
          description:
            "A simple band with a hand-hammered finish that catches the light. Resized once at no charge within 30 days.",
          sizes: [
            { label: "Size 6", price: 890 },
            { label: "Size 8", price: 890 },
            { label: "Size 10", price: 890 },
          ],
          photo: {
            scene:
              "a plain silver ring with a hammered surface standing upright on a small wooden jewellery tray",
            bundled: "/themes/ritual/massage-stone.webp",
          },
        },
      ],
      categories: [
        hide("seating"),
        hide("lighting"),
        hide("objects"),
        hide("textiles-art"),
        create(
          "Earrings",
          "earrings",
          "Jhumkas and everyday earrings made by hand in our Jaipur workshop.",
        ),
        create("Anklets", "anklets", "Silver anklets with ghungroo bells."),
        create(
          "Rings",
          "rings",
          "Simple silver bands, resized once at no charge within 30 days.",
        ),
      ],
    },
  },
  {
    slug: "neem-ritual",
    storeName: "Neem Ritual",
    themeId: "ritual",
    place: { city: "Kochi", state: "Kerala" },
    request: {
      brief: {
        business:
          "Small-batch skincare and hair care made in Kochi with neem, turmeric and coconut oil: a face wash, a night cream and a hair oil.",
        look: "Fresh and calm, leafy green and off-white, clean and simple, like a Kerala courtyard after the rain.",
        audience:
          "People who keep a simple daily routine for their skin and hair and like short ingredient lists.",
        facts: [
          "Everything is made in small batches in our Kochi workshop.",
          "Every label lists all the ingredients.",
          "Our coconut oil comes from a mill in Thrissur.",
          "Each batch carries a batch number and a use-by date.",
        ],
        avoid:
          "Medical claims such as curing acne or healing skin conditions, words like chemical-free or toxin-free, and doctor or dermatologist claims.",
        language: "English",
      },
      products: [
        {
          name: "Neem and Tulsi Face Wash",
          categorySlug: "face",
          description:
            "A gentle gel face wash with neem and tulsi for everyday use, morning and night.",
          sizes: [
            { label: "100 ml", price: 349 },
            { label: "200 ml", price: 599, mrp: 650 },
          ],
          photo: {
            scene:
              "a small green squeeze tube of face wash lying on a light wooden bathroom shelf beside a few fresh neem leaves",
            bundled: "/themes/ritual/cleanser.webp",
          },
        },
        {
          name: "Turmeric Night Cream",
          categorySlug: "face",
          description:
            "A rich night cream with turmeric and coconut oil, for skin that feels dry by the end of the day.",
          sizes: [{ label: "50 g", price: 549 }],
          photo: {
            scene:
              "a small round amber glass jar of cream with a plain lid, open, on a white windowsill with soft daylight",
            bundled: "/themes/ritual/moisturizer.webp",
          },
        },
        {
          name: "Coconut and Hibiscus Hair Oil",
          categorySlug: "hair",
          description:
            "Coconut oil from Thrissur with hibiscus flowers, for a weekly oiling before you wash your hair.",
          sizes: [
            { label: "100 ml", price: 299 },
            { label: "200 ml", price: 520 },
          ],
          photo: {
            scene:
              "a clear glass bottle of hair oil with red hibiscus petals inside, standing on a stone ledge beside a hibiscus flower",
            bundled: "/themes/ritual/serum.webp",
          },
        },
      ],
      categories: [
        hide("home"),
        hide("tools"),
        {
          action: "update",
          slug: "face",
          description: "Face washes and creams made in small batches in Kochi.",
          new_photo: true,
          merchant_confirmed: true,
        },
        hide("body"),
        create("Hair", "hair", "Hair oils made in small batches in Kochi."),
      ],
    },
  },
];
