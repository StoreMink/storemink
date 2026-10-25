/**
 * Step 10 of the robustness audit's uniqueness plan (section 5 of
 * revamp-handoff/tasks/mink-robustness-plan.md, outside the repo): do Mink
 * storefront redesigns come out distinct? Three bakeries and three skincare
 * shops on ONE theme, each planned for its first redesign and again for a
 * redo, text only: the planner, the compiler and the redo memory's check
 * (lib/mink/revamp/distinctness.ts), never a photograph.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/revamp-uniqueness-test.ts
 *       Dry run, the default: the offline planner (MINK_REVAMP_PROVIDER=fake),
 *       no network and no database, $0. Prints the table, and what a live run
 *       would cost.
 *   ... scripts/revamp-uniqueness-test.ts --live --budget-usd=<n>
 *       The paid run, which needs the owner's approval first: 12 planning
 *       calls to gemini-3.8-flash in storemink-staging (each shop's first
 *       plan and its redo), about $1.15 expected (an estimate the dry run
 *       prints), no repair calls. Refused without --budget-usd, above $2,
 *       with less than one call's ceiling, or outside storemink-staging.
 *       Exit 0 when every shop was planned, 1 when not, 2 when refused.
 *
 *   --theme=<id> picks the bundled theme every shop is on (default basket).
 *   --out=<file> also writes the whole report as JSON.
 *
 * WHAT IT MEASURES (the targets of section 5):
 *   - same trade on the same theme: every pair of bakeries, and every pair of
 *     skincare shops, at least the calibrated same-theme bar apart
 *     (`revampDistinctnessBar`: Theme Studio's 0.35 times the share of the
 *     fingerprint the theme leaves to a plan, 0.289 on every bundled theme);
 *   - a shop's redo at least the bar from its first redesign once the check
 *     has run (step 6's guarantee), and how far it was before the check;
 *   - under half of the closed section settings equal to the value the v4
 *     prompt printed for them (the audit found 62 of 70, 89%);
 *   - page colours not all near-white (the audit found 4 of 4).
 * ★★ "BEFORE" IS v4 AS MODELLED, NOT RE-PLANNED: the v4 prompt was changed in
 *    place by this wave and no longer exists in the code. Each shop's first
 *    answer is read again as a v4 answer (no prompt version, so the compiler's
 *    v4 rules), with every closed setting the v4 prompt printed set to the
 *    printed value, which is what the audit measured the live v4 planner
 *    doing; no memory and no check. Its direction, palette, fonts and page
 *    structure stay as the planner answered, so it is a generous v4. The
 *    audit's own measurement on real v4 plans is printed beside it.
 * ★★ IT NEVER SPENDS MORE THAN ITS BUDGET: a call starts only while what was
 *    spent, plus that call's ceiling (its prompt at three characters a token
 *    and the longest answer the model may write), fits in --budget-usd. Spend
 *    is priced from each answer's own tokens; a call that failed counts at its
 *    ceiling, since it may have run and been billed. Calls run one at a time.
 * ★★ IT NEVER TOUCHES PRODUCTION: a live run needs THEME_STUDIO_GCP_PROJECT_ID
 *    (else GCP_PROJECT_ID) to be storemink-staging, refuses any project or
 *    quota project naming "prod" and any GOOGLE_VERTEX_BASE_URL, and counts
 *    its calls against staging's quota (GOOGLE_CLOUD_QUOTA_PROJECT). No
 *    database, no bucket, no shared provider capacity: the planner's client is
 *    built without one, with its own 429 back-off.
 * ★ The shops reuse scripts/revamp-live-fixtures.ts (crumb-and-co and
 *   neem-ritual), with two more of each trade written the same way: the
 *   merchant's own facts, nothing a regulator would question, no photos. Each
 *   is installed on the chosen theme as a fresh store: the theme's pages and
 *   sample catalogue, its sample categories hidden and the shop's own created
 *   (the changes the merchant agreed to in the interview).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { themeDesignDefaults } from "../lib/chrome/design";
import {
  DEFAULT_CHROME,
  resolveStorefrontAppearance,
} from "../lib/chrome/types";
import type {
  RevampRequest,
  RevampSitePlan,
  RevampSnapshot,
} from "../lib/mink/revamp/contract";
import {
  earlierDesignsSummary,
  makeDistinct,
  revampDistances,
  revampDistinctnessBar,
  revampFingerprint,
  revampKeptSectionIds,
  revampThemeFixedShare,
  type RevampDistinctReport,
} from "../lib/mink/revamp/distinctness";
import type { RevampStepContext } from "../lib/mink/revamp/ports";
import { readRevampRequest } from "../lib/mink/revamp/request";
import {
  REVAMP_SECTION_CHOICES,
  compileRevampSite,
  finalizeRevampSite,
  normalizeRevampHex,
  revampSectionExample,
} from "../lib/mink/revamp/site-compiler";
import {
  REVAMP_PLANNER_MODEL_KEY,
  planRevampSite,
  type RevampPlannerOptions,
} from "../lib/mink/revamp/site-planner";
import {
  revampSiteContent,
  revampSiteSystem,
  type RevampSiteInput,
} from "../lib/mink/revamp/site-schema";
import type { MinkActorContext } from "../lib/mink/types";
import { ratesFor } from "../lib/theme-studio/cost";
import { THEME_DEFINITIONS } from "../lib/themes";
import { normalizeAnnouncement } from "../lib/themes/announcement";
import type { ThemeDefinition } from "../lib/themes/types";
import { REVAMP_LIVE_FIXTURES } from "./revamp-live-fixtures";

// ---------------------------------------------------------------------------
// The run's limits.
// ---------------------------------------------------------------------------

export const STAGING_PROJECT = "storemink-staging";
/** ★ The most a live run may be given (step 10: "about $1 to $2, once"). */
export const MAX_BUDGET_USD = 2;
/** Each shop's first plan and its redo. */
export const CALLS_PER_SHOP = 2;
/**
 * ★ The longest answer one planning call may cost: the model's 65,536 output
 *   tokens plus 32,768 of thinking. The planner sets no output cap (HIGH
 *   thinking), so this is the bound the budget assumes, deliberately high.
 */
export const CALL_OUTPUT_CEILING_TOKENS = 98_304;
/**
 * What a planning call is expected to write, answer and thinking together:
 * an estimate (a whole site of about 12k tokens and as much thinking), for the
 * printed estimate only; the budget uses the ceiling and the real usage.
 */
export const CALL_OUTPUT_EXPECTED_TOKENS = 24_000;
/** One call's whole clock, the planner's own (site-planner.ts). */
const CALL_DEADLINE_MS = 10 * 60_000;

/** The audit's measurement on real v4 plans (23 Oct 2026, section 5). */
export const V4_AS_MEASURED = {
  redo: 0.166,
  copied: { same: 62, total: 70 },
  nearWhite: { nearWhite: 4, total: 4 },
} as const;

// ---------------------------------------------------------------------------
// The shops.
// ---------------------------------------------------------------------------

export type ShopTrade = "bakery" | "skincare";

export interface UniquenessShop {
  slug: string;
  storeName: string;
  trade: ShopTrade;
  place: { city: string; state: string };
  brief: {
    business: string;
    look: string;
    audience: string;
    facts: string[];
    avoid: string;
    language: "English";
  };
  products: Array<{
    name: string;
    description: string;
    categorySlug: string;
    sizes: Array<{ label: string; price: number; mrp?: number }>;
  }>;
  /** The shop's own categories, created in place of the theme's samples. */
  categories: Array<{ name: string; slug: string; description: string }>;
}

/** A live-check shop as one of this test's: its brief, products and categories. */
function fromLiveFixture(slug: string, trade: ShopTrade): UniquenessShop {
  const fixture = REVAMP_LIVE_FIXTURES.find((shop) => shop.slug === slug);
  if (!fixture) throw new Error(`No live-check shop called ${slug}.`);
  const title = (value: string) =>
    value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");
  return {
    slug: fixture.slug,
    storeName: fixture.storeName,
    trade,
    place: fixture.place,
    brief: fixture.request.brief,
    products: fixture.request.products.map((product) => ({
      name: product.name,
      description: product.description,
      categorySlug: product.categorySlug,
      sizes: product.sizes,
    })),
    // ★ A category the merchant agreed to change on the shop's own theme
    //   becomes one of its own here, whatever theme the test is on.
    categories: fixture.request.categories.flatMap((change) =>
      change.action === "create"
        ? [
            {
              name: change.name,
              slug: change.slug,
              description: change.description,
            },
          ]
        : change.action === "update"
          ? [
              {
                name: title(change.slug),
                slug: change.slug,
                description: change.description,
              },
            ]
          : [],
    ),
  };
}

export const UNIQUENESS_SHOPS: readonly UniquenessShop[] = [
  fromLiveFixture("crumb-and-co", "bakery"),
  {
    slug: "rotiwala-bakehouse",
    storeName: "Rotiwala Bakehouse",
    trade: "bakery",
    place: { city: "Jaipur", state: "Rajasthan" },
    brief: {
      business:
        "A family bakery in Jaipur's old city baking whole wheat loaves, rusks and nankhatai in a wood-fired oven, sold from our shop and delivered across Jaipur.",
      look: "Earthy and old-fashioned, terracotta and wheat colours, like a bakery that has been on the same street for years.",
      audience:
        "Families in Jaipur who buy bread and tea-time biscuits every week, and visitors who want to take some home.",
      facts: [
        "We bake in a wood-fired oven in Jaipur's old city.",
        "Our rusks are baked twice, every Tuesday and Friday.",
        "We deliver within Jaipur, and orders placed before noon arrive the same day.",
      ],
      avoid:
        "Fancy French words, health claims, and anything that sounds like a factory.",
      language: "English",
    },
    products: [
      {
        name: "Whole Wheat Loaf",
        categorySlug: "breads",
        description:
          "A soft whole wheat loaf from our wood-fired oven, sliced on request.",
        sizes: [{ label: "400 g", price: 70 }],
      },
      {
        name: "Elaichi Rusk",
        categorySlug: "rusks",
        description:
          "Crisp rusks with cardamom, baked twice, for dipping in tea.",
        sizes: [
          { label: "300 g", price: 120 },
          { label: "600 g", price: 220 },
        ],
      },
      {
        name: "Nankhatai",
        categorySlug: "biscuits",
        description:
          "Crumbly ghee biscuits topped with a few slivers of almond.",
        sizes: [{ label: "250 g", price: 180 }],
      },
    ],
    categories: [
      {
        name: "Breads",
        slug: "breads",
        description: "Loaves from our wood-fired oven.",
      },
      {
        name: "Rusks",
        slug: "rusks",
        description: "Twice-baked rusks for tea time.",
      },
      {
        name: "Biscuits",
        slug: "biscuits",
        description: "Nankhatai and tea-time biscuits.",
      },
    ],
  },
  {
    slug: "sugarloaf-cakes",
    storeName: "Sugarloaf Cakes",
    trade: "bakery",
    place: { city: "Kolkata", state: "West Bengal" },
    brief: {
      business:
        "A home bakery in Salt Lake, Kolkata, making celebration cakes, cupcakes and plum cake to order, delivered across Kolkata.",
      look: "Playful and bright, pink and cream with a little gold, fun for birthdays without looking childish.",
      audience:
        "Parents planning birthdays, and people sending a cake to someone in Kolkata.",
      facts: [
        "Every cake is baked to order in our Salt Lake kitchen.",
        "Celebration cakes need two days' notice.",
        "We deliver across Kolkata between 10 am and 8 pm.",
      ],
      avoid:
        "Words like luxury or gourmet, and any claim about ingredients we cannot show.",
      language: "English",
    },
    products: [
      {
        name: "Chocolate Celebration Cake",
        categorySlug: "cakes",
        description:
          "A chocolate sponge layered with chocolate cream, with a name piped on top.",
        sizes: [
          { label: "1 kg", price: 1100 },
          { label: "2 kg", price: 2100 },
        ],
      },
      {
        name: "Vanilla Cupcakes",
        categorySlug: "cupcakes",
        description:
          "Six vanilla cupcakes with buttercream swirls in the colours you choose.",
        sizes: [{ label: "Box of 6", price: 480 }],
      },
      {
        name: "Christmas Plum Cake",
        categorySlug: "cakes",
        description:
          "A dense plum cake with dried fruit and spice, baked in December.",
        sizes: [{ label: "500 g", price: 650 }],
      },
    ],
    categories: [
      {
        name: "Cakes",
        slug: "cakes",
        description: "Celebration cakes baked to order.",
      },
      {
        name: "Cupcakes",
        slug: "cupcakes",
        description: "Cupcakes by the box.",
      },
    ],
  },
  fromLiveFixture("neem-ritual", "skincare"),
  {
    slug: "pushkar-rose",
    storeName: "Pushkar Rose",
    trade: "skincare",
    place: { city: "Udaipur", state: "Rajasthan" },
    brief: {
      business:
        "Small-batch face and body care made in Udaipur with rose, sandalwood and gram flour: a rose water toner, an ubtan face pack and a sandalwood soap.",
      look: "Soft and warm, dusty rose and sandstone, quiet and traditional rather than clinical.",
      audience:
        "Women who like a simple routine built on ingredients they know from home.",
      facts: [
        "Everything is made in small batches in our Udaipur workshop.",
        "Every label lists all the ingredients.",
        "Our rose water comes from a distiller in Pushkar.",
      ],
      avoid:
        "Medical claims, fairness or whitening words, and words like chemical-free.",
      language: "English",
    },
    products: [
      {
        name: "Rose Water Toner",
        categorySlug: "face",
        description:
          "Rose water from Pushkar in a spray bottle, for after you wash your face.",
        sizes: [
          { label: "100 ml", price: 260 },
          { label: "200 ml", price: 450 },
        ],
      },
      {
        name: "Ubtan Face Pack",
        categorySlug: "face",
        description:
          "A powder of gram flour, turmeric and sandalwood to mix with water or milk.",
        sizes: [{ label: "100 g", price: 320 }],
      },
      {
        name: "Sandalwood Soap",
        categorySlug: "body",
        description:
          "A cold-process bar soap with sandalwood oil, cut by hand.",
        sizes: [{ label: "100 g", price: 180 }],
      },
    ],
    categories: [
      {
        name: "Face",
        slug: "face",
        description: "Toners and face packs made in Udaipur.",
      },
      {
        name: "Body",
        slug: "body",
        description: "Soaps made by hand in small batches.",
      },
    ],
  },
  {
    slug: "coastline-care",
    storeName: "Coastline Care",
    trade: "skincare",
    place: { city: "Panaji", state: "Goa" },
    brief: {
      business:
        "Skincare for hot, humid days, made in Panaji with coconut oil, aloe vera and kokum butter: a lip balm, an aloe gel and a body lotion.",
      look: "Fresh and breezy, sea blue and sand, light and modern.",
      audience:
        "People living by the coast, and travellers who want light skincare for the heat.",
      facts: [
        "Made in small batches in our Panaji workshop.",
        "Every jar carries a batch number and a use-by date.",
        "We pack every order by hand and ship across India.",
      ],
      avoid:
        "Medical claims, sun protection or SPF claims, and words like natural or organic.",
      language: "English",
    },
    products: [
      {
        name: "Coconut Lip Balm",
        categorySlug: "lips",
        description:
          "A lip balm made with coconut oil and beeswax, in a small tin.",
        sizes: [{ label: "10 g", price: 199 }],
      },
      {
        name: "Aloe Vera Gel",
        categorySlug: "body",
        description: "A light aloe vera gel that dries quickly on the skin.",
        sizes: [{ label: "100 ml", price: 299 }],
      },
      {
        name: "Kokum Butter Body Lotion",
        categorySlug: "body",
        description: "A body lotion with kokum butter that soaks in quickly.",
        sizes: [{ label: "200 ml", price: 449 }],
      },
    ],
    categories: [
      {
        name: "Lips",
        slug: "lips",
        description: "Lip balms made in Panaji.",
      },
      {
        name: "Body",
        slug: "body",
        description: "Gels and lotions for hot days.",
      },
    ],
  },
];

/** A fixed id per shop and redesign, so a dry run is the same every time. */
export function harnessUuid(group: number, index: number): string {
  const hex = (n: number, width: number) =>
    n.toString(16).padStart(width, "0").slice(-width);
  return `${hex(group, 8)}-0000-4000-8000-${hex(index, 12)}`;
}

const storeIdOf = (index: number) => harnessUuid(0x5701, index + 1);
const firstIdOf = (index: number) => harnessUuid(0x5702, index + 1);
const redoIdOf = (index: number) => harnessUuid(0x5703, index + 1);

/**
 * The shop as the snapshot step reads a store right after its theme was
 * installed (lib/mink/revamp/snapshot.ts): the theme's pages, every section
 * the theme's, its sample categories and products, the platform's chrome,
 * and the shop's place. The theme facts are worked out the way snapshot.ts
 * `themeInfo` works them out.
 */
export function harnessSnapshot(
  theme: ThemeDefinition,
  shop: UniquenessShop,
  storeId: string,
): RevampSnapshot {
  const design = theme.preset.design;
  const palette = themeDesignDefaults(design).palette;
  const page = palette.cream ?? "#ffffff";
  const ink = palette.ink ?? "#111111";
  const layout = resolveStorefrontAppearance(
    design.layout,
    DEFAULT_CHROME.appearance,
    theme.preset.templates,
  );
  const announcement = normalizeAnnouncement(theme.preset.announcement);
  const samples = theme.preset.sampleData ?? { categories: [], products: [] };
  const categoryIds = new Map(
    samples.categories.map((category, index) => [
      category.slug,
      harnessUuid(0x5704, index + 1),
    ]),
  );
  return {
    storeId,
    storeName: shop.storeName,
    storeSlug: shop.slug,
    launched: true,
    theme: {
      id: theme.id,
      version: theme.release?.version ?? null,
      name: theme.name,
      palette: {
        page,
        surface: palette.surface ?? page,
        ink,
        accent:
          palette.accent ??
          normalizeRevampHex(theme.preset.brand?.primaryColor) ??
          ink,
      },
      layout: {
        header: layout.header,
        card: layout.cardQuickAdd ? "quick_add" : layout.card,
        productDetail: layout.productDetail,
        cart: layout.cart,
        footer: layout.footer,
      },
      announcement: announcement
        ? { text: announcement.text, href: announcement.href ?? "" }
        : null,
    },
    pages: theme.preset.pages.map((seed, index) => ({
      id: harnessUuid(0x5705, index + 1),
      slug: seed.slug,
      title: seed.title,
      status: "published",
      version: "harness",
      sectionsDigest: "harness",
      sections: seed.sections,
      owners: Object.fromEntries(
        seed.sections.map((section) => [section.id, "theme" as const]),
      ),
      skipped: null,
      seoTitle: seed.seo_title ?? null,
      seoDescription: seed.seo_description ?? null,
    })),
    chrome: {
      rowExists: false,
      version: null,
      digest: "harness",
      value: DEFAULT_CHROME,
    },
    brand: {
      tagline: theme.preset.brand?.tagline ?? null,
      blurb: theme.preset.brand?.blurb ?? null,
      digest: "harness",
    },
    categories: samples.categories.map((category) => ({
      id: categoryIds.get(category.slug)!,
      slug: category.slug,
      name: category.name,
      description: category.description ?? null,
      imageUrl: category.image_url ?? null,
      status: "published",
      updatedAt: "2026-10-24T00:00:00.000Z",
      sample: true,
      productCount: samples.products.filter(
        (product) => product.category_slug === category.slug,
      ).length,
    })),
    products: samples.products.map((product, index) => ({
      id: harnessUuid(0x5706, index + 1),
      name: product.name,
      slug: product.slug,
      // A theme's samples are seeded as drafts (lib/themes/apply.ts).
      status: "draft",
      updatedAt: "2026-10-24T00:00:00.000Z",
      sample: true,
      imageUrl: product.image_url,
      categoryId: categoryIds.get(product.category_slug) ?? null,
      featured: product.featured === true,
    })),
    facts: {
      delivery: null,
      freeDeliveryAbove: null,
      returns: null,
      pickup: false,
      onlinePayments: true,
      cashOnDelivery: true,
      city: shop.place.city,
      state: shop.place.state,
    },
    photos: { replaceable: [], broken: [], readable: [] },
    entitlements: { customCode: false },
  };
}

/**
 * The shop's full redesign as the start tool reads it (`readRevampRequest`):
 * its brief and products (no photographs: this test is text only), every
 * sample category of the theme hidden and its own created. ★ A sample at the
 * address of one of the shop's own is updated instead, never hidden and
 * created again (the live fixtures' rule: an update keeps the address).
 */
export function harnessRequest(
  theme: ThemeDefinition,
  shop: UniquenessShop,
): RevampRequest {
  const own = new Map(shop.categories.map((c) => [c.slug, c]));
  const samples = theme.preset.sampleData?.categories ?? [];
  const sampleSlugs = new Set(samples.map((category) => category.slug));
  const read = readRevampRequest(
    {
      brief: shop.brief,
      products: shop.products.map((product) => ({
        name: product.name,
        description: product.description,
        sizes: product.sizes.map((size) => ({
          label: size.label,
          price: size.price,
          mrp: size.mrp ?? null,
        })),
        photo_url: null,
        category_slug: product.categorySlug,
      })),
      categories: [
        ...samples.map((category) =>
          own.has(category.slug)
            ? {
                action: "update",
                slug: category.slug,
                description: own.get(category.slug)!.description,
                new_photo: false,
                merchant_confirmed: true,
              }
            : { action: "hide", slug: category.slug, merchant_confirmed: true },
        ),
        ...shop.categories
          .filter((category) => !sampleSlugs.has(category.slug))
          .map((category) => ({
            action: "create",
            name: category.name,
            slug: category.slug,
            description: category.description,
            new_photo: false,
            merchant_confirmed: true,
          })),
      ],
      pages: null,
    },
    "full",
  );
  if (!read.ok) {
    throw new Error(
      `The ${shop.slug} request does not read: ${read.issues.join(" ")}`,
    );
  }
  return read.value;
}

// ---------------------------------------------------------------------------
// v4, as modelled, and the copied choices.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The value the v4 prompt printed for a closed setting: the section's own
 * example (`revampSectionExample`, the registry's defaults), which the v4
 * examples printed as they were; the opening's height was never printed.
 */
function printedValue(type: string, key: string): unknown {
  if (key === "height") return undefined;
  const example = revampSectionExample(
    type as Parameters<typeof revampSectionExample>[0],
  );
  return example[key];
}

/** The printed value of an item's closed setting, by the item's place. */
function printedItemValue(
  type: string,
  listKey: string,
  index: number,
  key: string,
): unknown {
  const example = revampSectionExample(
    type as Parameters<typeof revampSectionExample>[0],
  );
  const list = example[listKey];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const item = list[index % list.length];
  return isRecord(item) ? item[key] : undefined;
}

/**
 * An answer read again as v4 would have taken it: no prompt version (so the
 * compiler's v4 rules: one global default for what is left out, the page
 * colour as answered), and every closed setting the v4 prompt printed set to
 * the printed value, the audit's finding for the live v4 planner (62 of 70).
 */
export function v4Answer(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const rest: Json = { ...raw };
  delete rest.promptVersion;
  if (!Array.isArray(rest.pages)) return rest;
  rest.pages = rest.pages.map((page) => {
    if (!isRecord(page) || !Array.isArray(page.sections)) return page;
    return {
      ...page,
      sections: page.sections.map((section) => {
        if (
          !isRecord(section) ||
          typeof section.type !== "string" ||
          typeof section.configJson !== "string"
        ) {
          return section;
        }
        const type = section.type;
        const table =
          REVAMP_SECTION_CHOICES[type as keyof typeof REVAMP_SECTION_CHOICES];
        if (!table) return section;
        let config: unknown;
        try {
          config = JSON.parse(section.configJson);
        } catch {
          return section;
        }
        if (!isRecord(config)) return section;
        for (const key of Object.keys(table.fields ?? {})) {
          const value = printedValue(type, key);
          if (value !== undefined) config[key] = value;
        }
        for (const key of Object.keys(table.items ?? {})) {
          for (const [listKey, list] of Object.entries(config)) {
            if (!Array.isArray(list)) continue;
            config[listKey] = list.map((item, index) => {
              if (!isRecord(item)) return item;
              const value = printedItemValue(type, listKey, index, key);
              return value === undefined ? item : { ...item, [key]: value };
            });
          }
        }
        return { ...section, configJson: JSON.stringify(config) };
      }),
    };
  });
  return rest;
}

export interface Tally {
  same: number;
  total: number;
  /**
   * How many would equal the printed value by chance, every setting picked
   * at random from its closed list (one in two for a left-or-right): the
   * level below which a share says nothing about copying.
   */
  chance: number;
}

/**
 * How many of a plan's closed section settings (`REVAMP_SECTION_CHOICES`,
 * the opening's height aside) equal the value the v4 prompt printed for them,
 * over the sections the plan writes: the audit's measure (copied.py, top-level
 * settings only).
 */
export function copiedChoices(
  plan: RevampSitePlan,
  snapshot: RevampSnapshot,
): Tally {
  const kept = new Set(
    snapshot.pages.flatMap((page) =>
      page.sections.map((section) => section.id),
    ),
  );
  const tally: Tally = { same: 0, total: 0, chance: 0 };
  for (const page of plan.pages) {
    for (const section of page.sections) {
      if (kept.has(section.id)) continue;
      const table =
        REVAMP_SECTION_CHOICES[
          section.type as keyof typeof REVAMP_SECTION_CHOICES
        ];
      const config = section.config as unknown as Json;
      for (const [key, choice] of Object.entries(table?.fields ?? {})) {
        const printed = printedValue(section.type, key);
        if (printed === undefined || !(key in config)) continue;
        tally.total += 1;
        tally.chance += 1 / Math.max(1, choice.options.length);
        if (config[key] === printed) tally.same += 1;
      }
    }
  }
  return tally;
}

const addTally = (a: Tally, b: Tally): Tally => ({
  same: a.same + b.same,
  total: a.total + b.total,
  chance: a.chance + b.chance,
});

// ---------------------------------------------------------------------------
// Money.
// ---------------------------------------------------------------------------

/** One planning call's prompt, in characters: the rules and the request. */
export function promptChars(input: RevampSiteInput): number {
  return revampSiteSystem().length + revampSiteContent(input).length;
}

/** What one call can cost at most: its prompt and the longest answer. */
export function callCeilingUsd(chars: number, at = new Date()): number {
  const input = Math.ceil(chars / 3);
  const rate = ratesFor(REVAMP_PLANNER_MODEL_KEY, input, at);
  return (input * rate.input + CALL_OUTPUT_CEILING_TOKENS * rate.output) / 1e6;
}

/** What one call is expected to cost (an estimate, for the printout). */
export function callExpectedUsd(chars: number, at = new Date()): number {
  const input = Math.ceil(chars / 4);
  const rate = ratesFor(REVAMP_PLANNER_MODEL_KEY, input, at);
  return (input * rate.input + CALL_OUTPUT_EXPECTED_TOKENS * rate.output) / 1e6;
}

/**
 * ★ The budget rule: a call starts only while what was spent plus its own
 *   ceiling fits in the budget.
 */
export function mayStart(
  spentUsd: number,
  ceilingUsd: number,
  budgetUsd: number,
): boolean {
  return spentUsd + ceilingUsd <= budgetUsd + 1e-9;
}

/** The whole run, before any call: the largest prompt sets every ceiling. */
export function estimateRun(
  theme: ThemeDefinition,
  shops: readonly UniquenessShop[] = UNIQUENESS_SHOPS,
): {
  calls: number;
  expectedUsd: number;
  ceilingUsd: number;
  callCeilingUsd: number;
} {
  let largest = 0;
  shops.forEach((shop, index) => {
    const snapshot = harnessSnapshot(theme, shop, storeIdOf(index));
    const request = harnessRequest(theme, shop);
    // The redo's prompt carries the summary too: about 400 characters a line.
    largest = Math.max(
      largest,
      promptChars({
        request,
        snapshot,
        previous: null,
        revampId: redoIdOf(index),
      }) + 400,
    );
  });
  const calls = shops.length * CALLS_PER_SHOP;
  const ceiling = callCeilingUsd(largest);
  return {
    calls,
    expectedUsd: calls * callExpectedUsd(largest),
    ceilingUsd: calls * ceiling,
    callCeilingUsd: ceiling,
  };
}

// ---------------------------------------------------------------------------
// The options.
// ---------------------------------------------------------------------------

export interface Options {
  live: boolean;
  budgetUsd: number | null;
  theme: string;
  out: string | null;
}

const BUNDLED_THEMES = THEME_DEFINITIONS.map((theme) => theme.id);

/** The arguments, or the sentence that refuses them. */
export function readOptions(argv: readonly string[]): Options | string {
  const flags = new Set(["--live"]);
  const values = ["--budget-usd=", "--theme=", "--out="];
  for (const arg of argv) {
    if (!flags.has(arg) && !values.some((prefix) => arg.startsWith(prefix))) {
      return `Unknown argument ${arg}. See the comment at the top of scripts/revamp-uniqueness-test.ts.`;
    }
  }
  const value = (prefix: string) => {
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found === undefined ? null : found.slice(prefix.length).trim();
  };
  const live = argv.includes("--live");
  const budgetText = value("--budget-usd=");
  const theme = (value("--theme=") || "basket").toLowerCase();
  if (!BUNDLED_THEMES.includes(theme)) {
    return `No bundled theme called ${theme}. Choose one of: ${BUNDLED_THEMES.join(", ")}.`;
  }
  if (budgetText !== null && !live) {
    return "--budget-usd is for a live run (--live); a dry run costs nothing.";
  }
  let budgetUsd: number | null = null;
  if (live) {
    if (budgetText === null || budgetText === "") {
      return `A live run calls a paid model. Say how much it may spend with --budget-usd=<dollars>, at most ${MAX_BUDGET_USD}.`;
    }
    budgetUsd = Number(budgetText);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      return "--budget-usd must be a positive number of dollars.";
    }
    if (budgetUsd > MAX_BUDGET_USD) {
      return `Refused: --budget-usd=${budgetText} is above $${MAX_BUDGET_USD}, the most this test may spend (step 10: about $1 to $2, once).`;
    }
  }
  return { live, budgetUsd, theme, out: value("--out=") || null };
}

/**
 * Everything that would make a live run spend somewhere it must not. ★
 * Checked before any call; a dry run needs none of it.
 */
export function environmentProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const project =
    env.THEME_STUDIO_GCP_PROJECT_ID?.trim() || env.GCP_PROJECT_ID?.trim();
  if (!project) {
    problems.push(
      `No project: set THEME_STUDIO_GCP_PROJECT_ID or GCP_PROJECT_ID to ${STAGING_PROJECT}.`,
    );
  } else if (project !== STAGING_PROJECT) {
    problems.push(
      `The planner would run in "${project}"; this test runs only in ${STAGING_PROJECT}.`,
    );
  }
  for (const name of [
    "THEME_STUDIO_GCP_PROJECT_ID",
    "GCP_PROJECT_ID",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
  ]) {
    const value = env[name]?.trim();
    if (value && /prod/i.test(value)) {
      problems.push(`${name} is "${value}", a production project.`);
    }
  }
  if (env.GOOGLE_VERTEX_BASE_URL?.trim()) {
    problems.push(
      "GOOGLE_VERTEX_BASE_URL is set, which would send every call somewhere other than Vertex.",
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** One planning call: the model's answer, and what it cost. */
export type HarnessPlanner = (
  input: RevampSiteInput,
) => Promise<{ raw: unknown; usd: number }>;

/** A planner step context for a call made outside the runner. */
function harnessContext(revampId: string): RevampStepContext {
  return {
    revampId,
    // ★ No saved brand voice: these shops have none.
    actor: { brandVoice: null } as unknown as MinkActorContext,
    signal: new AbortController().signal,
    deadline: Date.now() + CALL_DEADLINE_MS,
    report: async () => {},
  };
}

/**
 * The dry run's planner: the production planning entry on the offline fake.
 * ★ It refuses to run unless the provider is the fake, so a dry run can never
 *   make a paid call, whatever the environment says.
 */
export function dryPlanner(): HarnessPlanner {
  return async (input) => {
    const { revampProvider } = await import("../lib/mink/revamp/provider");
    if (revampProvider() !== "fake") {
      throw new Error(
        "A dry run plans with the offline fake only (MINK_REVAMP_PROVIDER=fake).",
      );
    }
    const call = await planRevampSite(
      harnessContext(input.revampId ?? ""),
      input,
    );
    return { raw: call.raw, usd: call.usage.estimatedCostMicroUsd / 1e6 };
  };
}

/** The live run's planner: the production planning entry on a Vertex client. */
export function livePlanner(
  client: NonNullable<RevampPlannerOptions["client"]>,
): HarnessPlanner {
  return async (input) => {
    const call = await planRevampSite(
      harnessContext(input.revampId ?? ""),
      input,
      { client },
    );
    return { raw: call.raw, usd: call.usage.estimatedCostMicroUsd / 1e6 };
  };
}

/** A plan compiled as the runner compiles one, with no repair call. */
function compiled(
  raw: unknown,
  input: Parameters<typeof compileRevampSite>[1],
): RevampSitePlan {
  return compileRevampSite(raw, input).plan ?? finalizeRevampSite(raw, input);
}

export interface ShopResult {
  slug: string;
  trade: ShopTrade;
  /** Why the shop has no result (a failed call, the budget, a plan that did not compile). */
  missing: string | null;
  first: RevampSitePlan | null;
  v4: RevampSitePlan | null;
  redoBefore: RevampSitePlan | null;
  redo: RevampSitePlan | null;
  check: RevampDistinctReport | null;
}

export interface PairResult {
  trade: ShopTrade;
  a: string;
  b: string;
  v4: number;
  v5: number;
}

export interface UniquenessReport {
  mode: "dry" | "live";
  theme: { id: string; version: string; bar: number; fixedShare: number };
  shops: ShopResult[];
  pairs: PairResult[];
  redo: Array<{
    slug: string;
    before: number;
    after: number;
    status: string;
    changes: number;
  }>;
  copied: { v4: Tally; v5: Tally };
  pages: {
    v4: { notNearWhite: number; total: number };
    v5: { notNearWhite: number; total: number };
  };
  calls: number;
  spentUsd: number;
  budgetUsd: number | null;
  stopped: string | null;
  targets: {
    sameTrade: boolean;
    redo: boolean;
    copied: boolean;
    pages: boolean;
    complete: boolean;
  };
}

class BudgetStop extends Error {}

/**
 * A planning call that failed: the planner's closed code and whether it was
 * only a wait (site-planner.ts), or, for anything the planner did not
 * classify, its message.
 */
class PlannerFailure extends Error {
  constructor(
    readonly code: string | null,
    readonly transient: boolean,
    message: string,
  ) {
    super(message);
  }
}

function plannerFailure(error: unknown): PlannerFailure {
  const fields =
    error && typeof error === "object"
      ? (error as { code?: unknown; transient?: unknown })
      : {};
  return new PlannerFailure(
    typeof fields.code === "string" ? fields.code : null,
    fields.transient === true,
    error instanceof Error ? error.message.slice(0, 160) : "unknown",
  );
}

/**
 * Plans every shop's first redesign and its redo, one call at a time, and
 * measures them. A dry run spends nothing; a live one never starts a call its
 * budget cannot cover.
 */
export async function runUniquenessTest(
  options: Pick<Options, "live" | "budgetUsd"> & { theme: ThemeDefinition },
  planner: HarnessPlanner,
  shops: readonly UniquenessShop[] = UNIQUENESS_SHOPS,
): Promise<UniquenessReport> {
  const theme = options.theme;
  const bar = revampDistinctnessBar(theme);
  let calls = 0;
  let spentUsd = 0;
  let stopped: string | null = null;

  const plan = async (input: RevampSiteInput) => {
    const ceiling = callCeilingUsd(promptChars(input));
    if (options.live && !mayStart(spentUsd, ceiling, options.budgetUsd ?? 0)) {
      throw new BudgetStop(
        `stopped before call ${calls + 1}: $${spentUsd.toFixed(2)} spent and one more call may cost up to $${ceiling.toFixed(2)}, past the $${(options.budgetUsd ?? 0).toFixed(2)} budget`,
      );
    }
    calls += 1;
    try {
      const answer = await planner(input);
      spentUsd += Math.max(0, answer.usd);
      return answer.raw;
    } catch (error) {
      // ★ A call that failed may still have run and been billed.
      if (options.live) spentUsd += ceiling;
      throw plannerFailure(error);
    }
  };

  const results: ShopResult[] = [];
  for (const [index, shop] of shops.entries()) {
    const result: ShopResult = {
      slug: shop.slug,
      trade: shop.trade,
      missing: null,
      first: null,
      v4: null,
      redoBefore: null,
      redo: null,
      check: null,
    };
    results.push(result);
    if (stopped) {
      result.missing = "not planned: the run stopped";
      continue;
    }
    const storeId = storeIdOf(index);
    const snapshot = harnessSnapshot(theme, shop, storeId);
    const request = harnessRequest(theme, shop);
    const base = { request, snapshot, previous: null };
    try {
      // The store's first redesign: no memory, nothing to compare with.
      const firstId = firstIdOf(index);
      const raw = await plan({ ...base, revampId: firstId });
      result.first = compiled(raw, { ...base, revampId: firstId });
      result.v4 = compiled(v4Answer(raw), base);
      // Its redo: the planner sees the first, then the check runs.
      const redoId = redoIdOf(index);
      const summary = earlierDesignsSummary([result.first]);
      const redoRaw = await plan({
        ...base,
        revampId: redoId,
        earlierDesigns: summary,
      });
      result.redoBefore = compiled(redoRaw, { ...base, revampId: redoId });
      const checked = makeDistinct(
        theme,
        result.redoBefore,
        [result.first],
        request,
        {
          storeId,
          revampId: redoId,
          keptSectionIds: revampKeptSectionIds(snapshot),
        },
      );
      result.redo = checked.plan;
      result.check = checked.report;
    } catch (error) {
      if (error instanceof BudgetStop) {
        stopped = error.message;
        result.missing = "not planned: the budget";
        continue;
      }
      if (error instanceof PlannerFailure) {
        result.missing = `failed: ${error.code ?? error.message}`;
        // ★ A model that cannot be reached for good (a configuration or
        //   permission fault), or a failure the planner did not classify,
        //   would fail every shop the same way: stop paying. A busy model, or
        //   one that declined this shop's request, is only this shop's.
        if (error.code === null) {
          stopped = `stopped: ${error.message}`;
        } else if (!error.transient && error.code === "model_unavailable") {
          stopped = `stopped: the planner is not set up (${error.code})`;
        }
        continue;
      }
      // An answer nothing usable could be compiled from (no repair calls
      // here, to keep the run to its twelve calls): this shop's alone.
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "unknown";
      result.missing = `failed: ${code}`;
    }
  }

  // Same trade, same theme: every pair of first redesigns.
  const pairs: PairResult[] = [];
  for (const [i, a] of results.entries()) {
    for (const b of results.slice(i + 1)) {
      if (a.trade !== b.trade || !a.first || !b.first || !a.v4 || !b.v4) {
        continue;
      }
      pairs.push({
        trade: a.trade,
        a: a.slug,
        b: b.slug,
        v4: revampDistances(theme, a.v4, [b.v4])[0],
        v5: revampDistances(theme, a.first, [b.first])[0],
      });
    }
  }
  const redo = results.flatMap((result) =>
    result.first && result.redoBefore && result.redo && result.check
      ? [
          {
            slug: result.slug,
            before: revampDistances(theme, result.redoBefore, [
              result.first,
            ])[0],
            after: revampDistances(theme, result.redo, [result.first])[0],
            status: result.check.status,
            changes: result.check.changed.length,
          },
        ]
      : [],
  );
  const snapshots = new Map(
    shops.map((shop, index) => [
      shop.slug,
      harnessSnapshot(theme, shop, storeIdOf(index)),
    ]),
  );
  const v4Plans = results.flatMap((r) =>
    r.v4 ? [[r.slug, r.v4] as const] : [],
  );
  const v5Plans = results.flatMap((r) => [
    ...(r.first ? [[r.slug, r.first] as const] : []),
    ...(r.redo ? [[r.slug, r.redo] as const] : []),
  ]);
  const copied = (plans: ReadonlyArray<readonly [string, RevampSitePlan]>) =>
    plans.reduce<Tally>(
      (sum, [slug, plan]) =>
        addTally(sum, copiedChoices(plan, snapshots.get(slug)!)),
      { same: 0, total: 0, chance: 0 },
    );
  const pages = (plans: ReadonlyArray<readonly [string, RevampSitePlan]>) => ({
    notNearWhite: plans.filter(
      ([, plan]) => revampFingerprint(theme, plan).pageColour !== "near-white",
    ).length,
    total: plans.length,
  });
  const copiedV5 = copied(v5Plans);
  const pagesV5 = pages(v5Plans);
  const complete = !stopped && results.every((result) => !result.missing);
  return {
    mode: options.live ? "live" : "dry",
    theme: {
      id: theme.id,
      version: theme.release.version,
      bar,
      fixedShare: revampThemeFixedShare(theme),
    },
    shops: results,
    pairs,
    redo,
    copied: { v4: copied(v4Plans), v5: copiedV5 },
    pages: { v4: pages(v4Plans), v5: pagesV5 },
    calls,
    spentUsd,
    budgetUsd: options.budgetUsd ?? null,
    stopped,
    targets: uniquenessTargets({
      bar,
      pairs,
      redo,
      copied: copiedV5,
      pages: pagesV5,
      complete,
    }),
  };
}

/**
 * ★★ THE TARGETS OF SECTION 5, judged on v5 with the check: every pair of
 *   shops in the same trade at least the bar apart, every redo at least the
 *   bar from its first redesign after the check, under half of the settings
 *   equal to the v4 default, and not every page near-white. Only a run that
 *   planned every shop is complete; none is met with nothing measured.
 */
export function uniquenessTargets(input: {
  bar: number;
  pairs: ReadonlyArray<Pick<PairResult, "v5">>;
  redo: ReadonlyArray<{ after: number }>;
  copied: Pick<Tally, "same" | "total">;
  pages: { notNearWhite: number; total: number };
  complete: boolean;
}): UniquenessReport["targets"] {
  const { bar, pairs, redo, copied, pages } = input;
  return {
    sameTrade: pairs.length > 0 && pairs.every((pair) => pair.v5 >= bar),
    redo: redo.length > 0 && redo.every((entry) => entry.after >= bar),
    copied: copied.total > 0 && copied.same / copied.total < 0.5,
    pages: pages.total > 0 && pages.notNearWhite > 0,
    complete: input.complete,
  };
}

// ---------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------

const d3 = (n: number) => n.toFixed(3);
const share = (same: number, total: number) =>
  total ? `${Math.round((100 * same) / total)}%` : "-";
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
}
const spread = (values: readonly number[]) =>
  values.length ? `${d3(Math.min(...values))} / ${d3(median(values)!)}` : "-";

/** The short table the run prints. */
export function formatTable(report: UniquenessReport): string {
  const { bar } = report.theme;
  const met = (ok: boolean) => (ok ? "met" : "NOT MET");
  const row = (cells: string[], widths: number[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  const atBar = (values: readonly number[]) =>
    `${values.filter((v) => v >= bar).length} of ${values.length}`;
  const copied = (tally: Tally) =>
    `${share(tally.same, tally.total)} (${tally.same} of ${tally.total})`;
  const sameTrade = report.pairs.map((pair) => pair.v5);
  const redoAfter = report.redo.map((entry) => entry.after);
  const audit = V4_AS_MEASURED;
  const targets = [36, 22, 22, 7];
  const compare = [36, 22, 22, 22];
  const lines = [
    `Revamp uniqueness test (robustness audit, section 5, step 10): ${
      report.mode === "live"
        ? `LIVE, ${REVAMP_PLANNER_MODEL_KEY} in ${STAGING_PROJECT}`
        : "dry run, offline planner"
    }`,
    `Theme ${report.theme.id} ${report.theme.version}: same-theme bar ${d3(bar)} (0.35 x the ${(1 - report.theme.fixedShare).toFixed(3)} of the fingerprint a plan can move)`,
    `Shops: ${report.shops.map((shop) => `${shop.slug} (${shop.trade})`).join(", ")}`,
    "",
    row(["TARGETS (v5 with the check)", "result", "target", ""], targets),
    row(
      [
        "same trade, one theme: each pair",
        `${atBar(sameTrade)} at the bar`,
        `every pair >= ${d3(bar)}`,
        met(report.targets.sameTrade),
      ],
      targets,
    ),
    row(
      [
        "a shop's redo, after the check",
        `${atBar(redoAfter)} at the bar`,
        `every redo >= ${d3(bar)}`,
        met(report.targets.redo),
      ],
      targets,
    ),
    row(
      [
        "settings equal to the v4 default",
        copied(report.copied.v5),
        "under 50%",
        met(report.targets.copied),
      ],
      targets,
    ),
    row(
      [
        "pages not near-white",
        `${report.pages.v5.notNearWhite} of ${report.pages.v5.total}`,
        "not all near-white",
        met(report.targets.pages),
      ],
      targets,
    ),
    "",
    row(
      [
        "COMPARISON (closest / median)",
        "v4, audit (real)",
        "v4, modelled",
        "v5",
      ],
      compare,
    ),
    row(
      [
        "same trade, one theme",
        "not measured",
        spread(report.pairs.map((pair) => pair.v4)),
        spread(sameTrade),
      ],
      compare,
    ),
    row(
      [
        "a shop's redo, before the check",
        d3(audit.redo),
        "-",
        spread(report.redo.map((entry) => entry.before)),
      ],
      compare,
    ),
    row(
      ["a shop's redo, after the check", "-", "-", spread(redoAfter)],
      compare,
    ),
    row(
      [
        "settings equal to the v4 default",
        `${share(audit.copied.same, audit.copied.total)} (${audit.copied.same} of ${audit.copied.total})`,
        copied(report.copied.v4),
        copied(report.copied.v5),
      ],
      compare,
    ),
    row(
      [
        "  by chance alone",
        "-",
        share(report.copied.v4.chance, report.copied.v4.total),
        share(report.copied.v5.chance, report.copied.v5.total),
      ],
      compare,
    ),
    row(
      [
        "pages not near-white",
        `${audit.nearWhite.total - audit.nearWhite.nearWhite} of ${audit.nearWhite.total}`,
        `${report.pages.v4.notNearWhite} of ${report.pages.v4.total}`,
        `${report.pages.v5.notNearWhite} of ${report.pages.v5.total}`,
      ],
      compare,
    ),
    "",
    "v4, audit: three real v4 plans measured on 23 Oct (two shops on two themes). v4, modelled: each first answer read again as v4 would have taken it (every closed setting at the value the v4 prompt printed, the v4 compiler, no memory, no check), its colours, fonts and structure kept, since the v4 prompt itself no longer exists in the code.",
    `Redo checks: ${
      report.redo
        .map(
          (entry) => `${entry.slug} ${entry.status} (${entry.changes} changed)`,
        )
        .join(", ") || "none"
    }.`,
    `Planning calls: ${report.calls}; spent $${report.spentUsd.toFixed(2)}${
      report.budgetUsd !== null
        ? ` of a $${report.budgetUsd.toFixed(2)} budget`
        : ""
    }.`,
  ];
  const missing = report.shops.filter((shop) => shop.missing);
  if (missing.length || report.stopped) {
    lines.push(
      `INCOMPLETE: ${[
        ...missing.map((shop) => `${shop.slug} ${shop.missing}`),
        ...(report.stopped ? [report.stopped] : []),
      ].join("; ")}.`,
    );
  }
  const all = Object.values(report.targets).every(Boolean);
  lines.push(all ? "Every target met." : "Not every target met.");
  return lines.join("\n");
}

/** The report as JSON: numbers, slugs and each plan's design summary only. */
export function reportJson(report: UniquenessReport): string {
  return `${JSON.stringify(
    {
      ...report,
      shops: report.shops.map((shop) => ({
        slug: shop.slug,
        trade: shop.trade,
        missing: shop.missing,
        designs: {
          v4: shop.v4 ? earlierDesignsSummary([shop.v4]) : null,
          first: shop.first ? earlierDesignsSummary([shop.first]) : null,
          redoBeforeCheck: shop.redoBefore
            ? earlierDesignsSummary([shop.redoBefore])
            : null,
          redo: shop.redo ? earlierDesignsSummary([shop.redo]) : null,
        },
        check: shop.check,
      })),
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * ★★ Why a live run may not start, or null: the environment is not staging's,
 *   or the budget cannot cover even one call's ceiling. Asked after the
 *   options were read (which refuse a run without a budget or above $2) and
 *   before anything is called.
 */
export function liveRefusal(
  budgetUsd: number,
  env: NodeJS.ProcessEnv,
  estimate: Pick<ReturnType<typeof estimateRun>, "callCeilingUsd">,
): string | null {
  const problems = environmentProblems(env);
  if (problems.length) {
    return [
      `Refused: this test runs only against ${STAGING_PROJECT}.`,
      ...problems.map((p) => `  - ${p}`),
    ].join("\n");
  }
  if (!mayStart(0, estimate.callCeilingUsd, budgetUsd)) {
    return `Refused: one planning call may cost up to $${estimate.callCeilingUsd.toFixed(2)}, more than the $${budgetUsd.toFixed(2)} budget.`;
  }
  return null;
}

async function main(): Promise<number> {
  const options = readOptions(process.argv.slice(2));
  if (typeof options === "string") {
    console.error(options);
    return 2;
  }
  const theme = THEME_DEFINITIONS.find((t) => t.id === options.theme)!;
  const estimate = estimateRun(theme);
  const money = `${estimate.calls} planning calls, about $${estimate.expectedUsd.toFixed(2)} expected, at most $${estimate.callCeilingUsd.toFixed(2)} a call`;

  let planner: HarnessPlanner;
  if (options.live) {
    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });
    const refusal = liveRefusal(options.budgetUsd ?? 0, process.env, estimate);
    if (refusal) {
      console.error(refusal);
      return 2;
    }
    // ★ One read decides every step (provider.ts), and every call counts
    //   against staging's quota.
    process.env.MINK_REVAMP_PROVIDER = "vertex";
    process.env.GOOGLE_CLOUD_QUOTA_PROJECT = STAGING_PROJECT;
    const { createVertexModelClient, getVertexConfig } =
      await import("../lib/theme-studio/gemini-vertex");
    const vertex = getVertexConfig(process.env);
    if (!vertex) {
      console.error("Refused: no Vertex project is configured.");
      return 2;
    }
    // ★ No shared provider capacity: no database. The client's own 429
    //   back-off paces the calls, one at a time.
    planner = livePlanner(createVertexModelClient(vertex));
    console.log(
      `LIVE: ${money}; budget $${(options.budgetUsd ?? 0).toFixed(2)}.`,
    );
  } else {
    process.env.MINK_REVAMP_PROVIDER = "fake";
    planner = dryPlanner();
    console.log(
      `Dry run, $0. A live run (--live --budget-usd=<n>, at most $${MAX_BUDGET_USD}, only with the owner's approval) would make ${money}.`,
    );
  }

  const report = await runUniquenessTest(
    { live: options.live, budgetUsd: options.budgetUsd, theme },
    planner,
  );
  console.log("");
  console.log(formatTable(report));
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, reportJson(report));
    console.log(`Report: ${options.out}`);
  }
  return report.targets.complete ? 0 : 1;
}

if (basename(process.argv[1] ?? "") === "revamp-uniqueness-test.ts") {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
