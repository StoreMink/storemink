import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import { CHANGE_SCOPE_PROMPT_MARKER } from "./change-scope";
import {
  THEME_INTENT_SCHEMA_VERSION,
  validateThemeIntent,
  type ThemeContractResult,
  type ThemeIntent,
} from "./contracts";
import { pairingForFonts } from "@/lib/themes/fonts";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import { studio } from "@/lib/themes/definitions/studio";
import type { ThemeStudioModelClient } from "./provider";
import { ZERO_USAGE } from "./provider";
import { industryStartingPattern } from "./industry-playbooks";
import {
  VISIBLE_SECTION_CHOICES,
  REQUIRED_DESIGN_CHOICES,
} from "./style-choices";

// ---------------------------------------------------------------------------
// The Phase 2 provider: deterministic, offline, free.
//
// It exists so the whole durable pipeline — queue, lease, cancel, retry,
// immutable version, audit — can be exercised end to end before any model is
// wired in. It calls no network, reads no reference pixels, and produces a
// Stage A `ThemeIntent` that goes through the SAME validator a real model's
// output will, so a provider that returns something invalid fails the run
// rather than creating a version.
//
// ★ It says what it is. The intent's first assumption records that no model
// was called, so a fake version can never be mistaken for real analysis by
// anyone reading it later.
// ---------------------------------------------------------------------------

export interface FakeProviderInput {
  name: string;
  brief: string;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  requiredFeatures: ThemeFeature[];
  referenceCount: number;
  /** True once the operator has answered a clarifying question, so the
   * clarify drill asks once rather than forever. */
  answered?: boolean;
  /** Deterministic failure hook for tests and staging drills. */
  failWith?: "invalid_output";
}

function firstSentence(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? trimmed.slice(0, end + 1) : trimmed;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function runFakeProvider(
  input: FakeProviderInput,
): ThemeContractResult<ThemeIntent> {
  if (input.failWith === "invalid_output") {
    return validateThemeIntent({ schemaVersion: THEME_INTENT_SCHEMA_VERSION });
  }
  const large = input.catalogSizes.includes("large");
  const wantsFaq = input.requiredFeatures.includes("faq");
  // The offline image reviewer's drill hooks ride on the hero brief, so an
  // operator can exercise a redraw end to end (image-fake.ts).
  const reviewHooks = (
    input.brief.match(
      /\[\[fake-(?:review:[a-z_]+(?::always)?|image:(?:flaky|refuse))\]\]/g,
    ) ?? []
  ).join(" ");
  const starting = industryStartingPattern(input.industries);
  const intent: ThemeIntent = {
    schemaVersion: THEME_INTENT_SCHEMA_VERSION,
    summary: `${input.name}: ${firstSentence(input.brief, 400)}`,
    audiences: ["Shoppers described in the operator brief"],
    industries: [...input.industries],
    commercialGoals: [
      "Make the catalogue easy to browse on every device",
      "Keep the path from product to cart short",
    ],
    visual: {
      moodKeywords: ["clear", "considered"],
      paletteDirection: starting.playbook.colourFamilies.join(", "),
      typographyDirection: "A readable sans body with a distinct display face.",
      density: large ? "dense" : "balanced",
      shape: "mixed",
      motion: "restrained",
    },
    pagePlans: [
      {
        surface: "home",
        purpose: "Introduce the brand and route shoppers into the catalogue.",
        sectionTypes: [
          ...starting.playbook.homeSections.slice(0, 6),
          ...(wantsFaq ? ["faq_accordion"] : []),
        ],
      },
      {
        surface: "product",
        purpose: "Make price, options and availability obvious.",
        sectionTypes: [],
      },
    ],
    responsive: {
      desktop: {
        composition: ["Wide hero", "Multi-column product grid"],
        navigation: "Primary navigation with visible search.",
        media: "Wide crops that preserve product scale.",
      },
      tablet: {
        composition: ["Two-column product grid"],
        navigation: "Secondary links collapse into a drawer.",
        media: "4:3 crops with protected focal points.",
      },
      mobile: {
        composition: ["Single-column story", "Two-up product grid"],
        navigation: "Thumb-reachable drawer and cart controls.",
        media: "Portrait crops authored for small screens.",
      },
    },
    assetBriefs: [
      {
        id: "home-hero",
        purpose: "Homepage hero",
        subject: `The store's own products in use${reviewHooks ? ` ${reviewHooks}` : ""}`,
        aspectRatio: "16:9",
        artDirection: "Natural light, no third-party logos or copied artwork.",
        source: "operator",
        // v28: a lifestyle hero may show an adult using the product.
        people: "adults",
      },
      // The opening is a slideshow (opening.ts, v27): a second scene of the
      // same shoot for its second slide.
      {
        id: "home-hero-2",
        purpose: "Homepage opening, slide 2",
        subject: "The same products set out on a table by a window",
        aspectRatio: "16:9",
        artDirection: "Natural light, no third-party logos or copied artwork.",
        source: "operator",
        people: "none",
      },
      {
        id: "product-photo",
        purpose: "Product photography for the whole range",
        subject: "Each product alone on a seamless warm backdrop",
        aspectRatio: "4:5",
        artDirection: "Soft window light from the left, eye-level camera.",
        source: "generate",
        people: "none",
      },
    ],
    referenceAnalysis: Array.from(
      { length: input.referenceCount },
      (_, referenceIndex) => ({
        referenceIndex,
        pageKind: "other" as const,
        structure: ["The fake provider does not inspect pixels."],
        hierarchy: [],
        palette: [],
        typography: [],
        imagery: [],
        responsiveClues: [],
        patternsToUse: [],
        copyingToAvoid: ["No reference content was copied."],
      }),
    ),
    assumptions: [
      "Fake provider output: no model was called and no reference image was analysed.",
      `The operator attached ${input.referenceCount} reference image(s).`,
    ],
    capabilityGaps: [],
  };
  return validateThemeIntent(intent);
}

// ---------------------------------------------------------------------------
// The offline model CLIENT. It implements the same interface as the Gemini
// client, so a fake run goes through the real pipeline: envelope handling,
// intent validation, compilation, placeholder rendering, package validation and
// the repair loop. What it returns is deterministic and built from the bundled
// Studio theme's tokens, so a fake version is always a valid package.
//
// Drill hooks, read from the operator's brief (never used by a real provider):
//   [[fake:clarify]]         Stage A asks a question
//   [[fake:decline]]         Stage A declines
//   [[fake:invalid_output]]  Stage A never returns a valid intent
//   [[fake:repair]]          Stage B's first draft is invalid; the repair fixes it
// ---------------------------------------------------------------------------

const FAKE_CATEGORIES = [
  { name: "Everyday", slug: "everyday" },
  { name: "Home", slug: "home" },
  { name: "Travel", slug: "travel" },
  { name: "Gifts", slug: "gifts" },
] as const;

function fakeDraft(intent: ThemeIntent, name: string): Record<string, unknown> {
  const slot = intent.assetBriefs[0]?.id ?? "home-hero";
  const secondSlot =
    intent.assetBriefs.find((b) => /slide 2/i.test(b.purpose))?.id ??
    intent.assetBriefs[1]?.id ??
    slot;
  // Products name the range's photography brief; the compiler gives each its
  // own slot from it (compiler.ts productSlotId).
  const productBrief =
    intent.assetBriefs.find((b) => /product/i.test(b.purpose))?.id ?? slot;
  const { palette, fonts, shape } = studio.preset.design;
  const noStyle = { scheme: null, padding: null, width: null };
  const section = (
    type: string,
    config: unknown,
    style: Record<string, unknown> = noStyle,
  ) => ({
    type,
    configJson: JSON.stringify(config),
    style: { ...noStyle, ...style },
  });
  return {
    description: `${name}: a clear, responsive storefront generated by the offline test provider.`,
    keywords: ["test", "storefront"],
    features: ["category-navigation"],
    // The studio preset is Inter + Fraunces, which is the editorial pairing;
    // v25 drafts name the pairing they chose.
    fontPairing: pairingForFonts(fonts),
    // v32: the page templates (plan Phase 2e), every block with every field.
    // A v33 answer writes this same object as its templatesJson string.
    templates: {
      product: {
        gallery: "thumbs-left",
        blocks: [
          "price",
          "variant_picker",
          "buy_box",
          "trust_row",
          "description",
          "accordion",
          "size_guide",
          "reviews",
          "recommendations",
          "sticky_bar",
        ].map((type) => ({
          type,
          items:
            type === "trust_row"
              ? [
                  { icon: "truck", label: "Free delivery over ₹999" },
                  { icon: "refresh", label: "Easy 14-day returns" },
                ]
              : [],
          rows:
            type === "accordion"
              ? [
                  { heading: "Care", body: "Wipe clean with a soft cloth." },
                  {
                    heading: "Shipping",
                    body: "Dispatched within two working days.",
                  },
                ]
              : [],
          columns: type === "size_guide" ? ["Height", "Width"] : [],
          sizes:
            type === "size_guide"
              ? [
                  { label: "Small", values: ["12", "9"] },
                  { label: "Large", values: ["18", "14"] },
                ]
              : [],
          html: "",
        })),
      },
      collection: {
        filters: "top-bar",
        pagination: "paged",
        promoTiles: [
          {
            afterIndex: 4,
            heading: "The everyday edit",
            body: "Pieces made to be used daily.",
            cta_label: "See the edit",
            href: "/shop",
            theme: "dark",
            background: null,
          },
        ],
      },
      blog: { index: "featured", article: "sidebar" },
      account: { layout: "tabs", scheme: "soft" },
    },
    // v32: the announcement bar above the header.
    announcement: {
      text: "Free delivery on orders over ₹999, easy 14-day returns",
      href: "/shop",
    },
    brand: {
      primaryColor: palette.ink,
      tagline: `${name} everyday essentials`,
      blurb: `${name} is an offline test storefront with a full sample catalogue.`,
    },
    design: {
      palette: { ...palette, accent: null, accentDeep: null },
      fonts,
      shape,
      layout: {
        header: "centered",
        headerBackground: null,
        headerForeground: null,
        card: "framed",
        cardHoverImage: null,
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: null,
        shopFilters: true,
        collectionBanner: true,
        productDetail: "editorial",
        cart: null,
        footer: "minimal",
        storefront: null,
      },
      // One declared scheme and one derived, so both paths run offline.
      schemes: {
        soft: null,
        tint: {
          background: "#dfe4ff",
          text: palette.ink,
          surface: null,
          accent: null,
          onAccent: null,
        },
        accent: null,
        inverse: null,
      },
      typography: {
        headingFont: "display",
        headingScale: "large",
        headingWeight: "semibold",
        headingCase: null,
        headingTracking: "tight",
      },
      buttons: {
        shape: "rounded",
        primary: null,
        secondary: "outline",
        case: null,
        weight: "semibold",
        tracking: null,
        hover: "lift",
      },
      page: { width: "standard", sectionGap: "airy", gridGap: null },
      motion: { reveal: "fade" },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seoTitle: null,
        seoDescription: null,
        sections: [
          // The opening every Studio theme uses (opening.ts): a slideshow of
          // photographs filling the band behind the copy, edge to edge, with
          // previous/next arrows.
          section(
            "hero_carousel",
            {
              ...EMPTY_CONFIG.hero_carousel,
              slides: [
                {
                  ...EMPTY_CONFIG.hero_carousel.slides[0],
                  heading: name,
                  subheading: `${name} everyday essentials`,
                  image_url: `theme-asset://${slot}`,
                  focal_y: 40,
                },
                {
                  ...EMPTY_CONFIG.hero_carousel.slides[0],
                  heading: "New this season",
                  cta_label: "See what's new",
                  image_url: `theme-asset://${secondSlot}`,
                  theme: "light",
                },
              ],
              interval_seconds: 6,
              height: "large",
            },
            { width: "full" },
          ),
          section("shop_by_category", EMPTY_CONFIG.shop_by_category, {
            scheme: "tint",
            width: "full",
          }),
          // A single full-band photo hero further down: the fullbleed variant
          // stays exercised, and the solid-hero fixtures copy it to About.
          section(
            "hero",
            {
              ...EMPTY_CONFIG.hero,
              variant: "fullbleed",
              heading: name,
              image_url: `theme-asset://${slot}`,
              height: "large",
              focal_y: 40,
            },
            { width: "full" },
          ),
          section("featured_products", EMPTY_CONFIG.featured_products),
          // Not last: the footer carries the store's signup form, and a
          // closing newsletter section would put two back to back (the
          // `newsletter_above_footer` copy floor).
          section("newsletter", EMPTY_CONFIG.newsletter, {
            scheme: "inverse",
            padding: "lg",
            width: "full",
          }),
          section("promo_banner", {
            ...EMPTY_CONFIG.promo_banner,
            heading: "New arrivals every week",
            cta_label: "Shop now",
            cta_href: "/shop",
          }),
          // Nested blocks (plan Phase 2b): typed rows under a section. Copy
          // carries no digits, so the brief-aware claims check has nothing
          // to ask for.
          section("accordion", {
            ...EMPTY_CONFIG.accordion,
            heading: "Good to know",
            items: [
              {
                type: "text",
                heading: "Shipping and returns",
                body: "Orders leave the workshop within a few working days, and a return is welcome for a fortnight.",
                image_url: "",
                image_alt: "",
              },
              {
                type: "image",
                heading: "Care",
                body: "Wipe with a damp cloth and keep away from direct heat.",
                image_url: `theme-asset://${slot}`,
                image_alt: "A finished piece on the workshop bench",
              },
            ],
          }),
          section("comparison", {
            ...EMPTY_CONFIG.comparison,
            heading: "Which size suits you",
            columns: [
              {
                label: "Small",
                caption: "For one",
                cta_label: "",
                cta_href: "",
                highlight: false,
              },
              {
                label: "Family",
                caption: "For the table",
                cta_label: "Shop the family size",
                cta_href: "/shop",
                highlight: true,
              },
            ],
            rows: [
              {
                type: "text",
                label: "Serves",
                values: ["One or two", "Four to six"],
              },
              {
                type: "check",
                label: "Dishwasher safe",
                values: ["yes", "yes"],
              },
              {
                type: "check",
                label: "Comes with a lid",
                values: ["no", "yes"],
              },
            ],
          }),
          // v30 (plan Phase 2c): columns of values with icons.
          section("multicolumn", {
            ...EMPTY_CONFIG.multicolumn,
            heading: "Why shop with us",
            items: [
              {
                icon: "leaf",
                image_url: "",
                image_alt: "",
                heading: "Made to last",
                body: "Materials chosen for the years, not the season.",
                cta_label: "",
                cta_href: "",
              },
              {
                icon: "truck",
                image_url: "",
                image_alt: "",
                heading: "Delivered with care",
                body: "Packed by hand and sent within a few working days.",
                cta_label: "",
                cta_href: "",
              },
              {
                icon: "refresh",
                image_url: "",
                image_alt: "",
                heading: "Easy returns",
                body: "Changed your mind? Send it back; we make it simple.",
                cta_label: "Read our policy",
                cta_href: "/refund-policy",
              },
            ],
          }),
        ],
      },
      {
        slug: "about",
        title: "About",
        seoTitle: null,
        seoDescription: null,
        sections: [
          section("media_text", {
            ...EMPTY_CONFIG.media_text,
            cta_href: "/shop",
            image_url: `theme-asset://${slot}`,
            image_alt: "The workshop where every piece is finished by hand",
          }),
          section("before_after", {
            ...EMPTY_CONFIG.before_after,
            heading: "From the kiln to the shelf",
            before: {
              image_url: `theme-asset://${slot}`,
              image_alt: "A piece before glazing",
              label: "Before",
            },
            after: {
              image_url: `theme-asset://${secondSlot}`,
              image_alt: "The same piece after glazing",
              label: "After",
            },
          }),
        ],
      },
    ],
    menus: {
      header: [
        {
          label: "Shop",
          href: "/shop",
          image_url: `theme-asset://${slot}`,
          children: [
            {
              label: "Everyday",
              href: "/collections/everyday",
              children: [{ label: "Sample one", href: "/shop/sample-one" }],
            },
          ],
        },
        { label: "About", href: "/about", image_url: "", children: [] },
      ],
      footerGroups: [
        { title: "Shop", links: [{ label: "All products", href: "/shop" }] },
      ],
      footerLegal: [],
    },
    // ★ Four categories and eight products: the production content floors
    // (validateThemeSampleData) now run in the compiler, and the offline
    // provider must produce a package that clears them, as a model must.
    categories: FAKE_CATEGORIES.map((category) => ({
      name: category.name,
      slug: category.slug,
      description: null,
      imageSlot: slot,
    })),
    products: [
      {
        name: "Sample one",
        slug: "sample-one",
        description: "A sample product from the offline provider.",
        categorySlug: "everyday",
        basePrice: 999,
        sellingPrice: 899,
        imageSlot: productBrief,
        featured: true,
        // One product with real option axes, so the offline path exercises
        // option compilation and the storefront pickers end to end.
        options: [
          { name: "Size", values: ["S", "M"], swatches: [] },
          {
            name: "Colour",
            values: ["Black", "Sand"],
            swatches: [
              { value: "Black", hex: "#111111" },
              { value: "Sand", hex: "#d6c3a1" },
            ],
          },
        ],
        variants: [
          ["S", "Black"],
          ["S", "Sand"],
          ["M", "Black"],
          ["M", "Sand"],
        ].map((optionValues) => ({
          name: optionValues.join(" / "),
          optionValues,
          basePrice: 999,
          sellingPrice: 899,
          stock: 5,
        })),
      },
      {
        name: "Sample two",
        slug: "sample-two",
        description: "Another sample product from the offline provider.",
        categorySlug: "everyday",
        basePrice: 1499,
        sellingPrice: 1499,
        imageSlot: productBrief,
        featured: false,
        options: [],
        variants: [],
      },
      ...FAKE_CATEGORIES.flatMap((category, c) =>
        [0, 1].map((n) => ({
          name: `${category.name} pick ${n + 1}`,
          slug: `${category.slug}-pick-${n + 1}`,
          description: `A ${category.name.toLowerCase()} sample product for testing.`,
          categorySlug: category.slug,
          basePrice: 499 + c * 100 + n * 50,
          sellingPrice: 499 + c * 100 + n * 50,
          imageSlot: productBrief,
          featured: n === 0,
          options: [],
          variants: [],
        })),
      ).slice(0, 6),
    ],
    capabilityGaps: [],
  };
}

/**
 * The offline provider's stylesheet (v34): enough rules, across enough areas,
 * to pass a new theme's "own hand" floor, and none whose contrast depends on
 * the palette (type, borders, shape, motion and the ink tone only).
 */
export const FAKE_STYLESHEET = [
  {
    hook: "product-card.title",
    declarations: {
      fontSize: "sm",
      fontWeight: 500,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
  },
  { hook: "product-card.price", declarations: { fontWeight: 600 } },
  {
    hook: "product-card",
    declarations: { borderWidth: 1, borderColor: "line", transition: "base" },
  },
  {
    hook: "product-card",
    state: "hover",
    declarations: { boxShadow: "lifted", transform: "lift" },
  },
  { hook: "product-card.image", declarations: { transition: "slow" } },
  {
    hook: "product-card.image",
    state: "hover",
    declarations: { transform: "zoom" },
  },
  {
    hook: "product-card.flag",
    declarations: {
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      tone: "ink",
      borderRadius: "none",
    },
  },
  {
    hook: "button.primary",
    declarations: {
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      tone: "ink",
      borderRadius: "none",
      transition: "fast",
    },
  },
  {
    hook: "button.primary",
    state: "hover",
    declarations: { boxShadow: "soft", transform: "lift-sm" },
  },
  {
    hook: "section.title",
    declarations: {
      fontSize: "3xl",
      letterSpacing: "-0.01em",
      textAlign: "center",
    },
  },
  {
    hook: "section.eyebrow",
    declarations: {
      fontSize: "xs",
      letterSpacing: "0.2em",
      textTransform: "uppercase",
    },
  },
  { hook: "hero.heading", declarations: { fontWeight: 300, lineHeight: 1.1 } },
  {
    hook: "category.name",
    declarations: {
      fontSize: "sm",
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    },
  },
  {
    hook: "collection.title",
    declarations: { fontSize: "4xl", fontWeight: 400 },
  },
  { hook: "product.title", declarations: { fontSize: "3xl", lineHeight: 1.2 } },
  {
    hook: "footer.heading",
    declarations: {
      fontSize: "xs",
      letterSpacing: "0.16em",
      textTransform: "uppercase",
    },
  },
  {
    hook: "header.nav-link",
    declarations: { fontSize: "sm", letterSpacing: "0.04em" },
  },
] as const;

/** The offline drill's design plan: a light page and a readable ink. */
export const FAKE_DESIGN_PLAN = {
  colours: {
    page: "#fbfaf7",
    surface: "#ffffff",
    ink: "#1f2a24",
    accent: "#2f5d50",
  },
  fontPairing: "editorial-fraunces",
  buttons: { shape: "rounded", primary: "solid" },
  layout: null,
  styling: [
    "Product names in the body face, medium weight.",
    "Prices a size up from the name, in the text colour.",
  ],
  setsApart: ["Fake provider output: no catalogue theme was read."],
} as const;

export function createFakeModelClient(
  input: FakeProviderInput,
): ThemeStudioModelClient {
  const hook = (name: string) => input.brief.includes(`[[fake:${name}]]`);
  /**
   * The change-scope request (change-scope.ts). Revise unless a hook says
   * otherwise, so every existing offline revision behaves as it always did.
   * `[[fake:edit]]` rewrites the first heading it is offered;
   * `[[fake:edit-image]]` asks to redraw the first redrawable picture.
   */
  const fakeChangeDecision = (content: readonly { type: string }[]) => {
    const block = content.find((b) => b.type === "text") as
      | { text?: string }
      | undefined;
    const text = block?.text ?? "{}";
    let context: {
      settings?: { path: string }[];
      redrawableImages?: { slotId: string }[];
    } = {};
    try {
      context = JSON.parse(text);
    } catch {
      /* not a change-scope request */
    }
    const decision = {
      scope: "revise",
      summary: "Offline provider: treated as a revision.",
      edits: [] as { path: string; valueJson: string }[],
      imageChanges: [] as { slotId: string; direction: string }[],
    };
    if (hook("recreate")) {
      decision.scope = "recreate";
      decision.summary = "Offline provider: starting over.";
    } else if (hook("edit") || hook("edit-image")) {
      decision.scope = "edit";
      decision.summary = "Offline provider: made a small edit.";
      const heading = context.settings?.find((t) =>
        t.path.endsWith("/config/heading"),
      );
      if (hook("edit") && heading)
        decision.edits.push({
          path: heading.path,
          valueJson: JSON.stringify("Edited by the offline provider"),
        });
      const image = context.redrawableImages?.[0];
      if (hook("edit-image") && image)
        decision.imageChanges.push({
          slotId: image.slotId,
          direction: "A brighter morning version of the same scene.",
        });
    }
    return decision;
  };
  return {
    provider: "fake",
    async generate(request) {
      if (request.stage === "visual_qa") {
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: {
            verdict: "pass",
            scores: {
              artDirection: 5,
              distinctness: 5,
              commerceClarity: 5,
              typography: 5,
              imagery: 5,
              responsiveComposition: 5,
              detailQuality: 5,
              brandAdaptability: 5,
            },
            rejections: [],
            findings: [],
            revisionBrief: null,
            repairs: [],
            imageAssessments: [],
          },
        };
      }
      if (
        request.stage === "intent" &&
        request.system?.startsWith(CHANGE_SCOPE_PROMPT_MARKER)
      ) {
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: fakeChangeDecision(request.content),
        };
      }
      const isRepair = request.content.some(
        (block) =>
          block.type === "text" &&
          block.text.includes("failed StoreMink validation"),
      );
      if (request.stage === "intent") {
        if (hook("clarify") && !input.answered) {
          return {
            kind: "ok",
            usage: ZERO_USAGE,
            value: {
              decision: "clarify",
              questions: ["Where will product photography come from?"],
              declineReason: null,
              intent: null,
            },
          };
        }
        if (hook("decline")) {
          return {
            kind: "ok",
            usage: ZERO_USAGE,
            value: {
              decision: "decline",
              questions: [],
              declineReason: "Test provider decline drill.",
              intent: null,
            },
          };
        }
        const intent = runFakeProvider({
          ...input,
          failWith: hook("invalid_output") ? "invalid_output" : undefined,
        });
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: {
            decision: "proceed",
            questions: [],
            declineReason: null,
            intent: intent.ok
              ? request.system?.includes("Design variety, schemaVersion 2")
                ? {
                    ...intent.value,
                    schemaVersion: 2,
                    designDirection: "magazine-editorial",
                    paletteFamily: "light",
                    // v34: the design plan, only where the schema asks
                    // (design-plan.ts). A fixed, valid plan: no model
                    // decided anything.
                    ...(JSON.stringify(request.schema ?? {}).includes(
                      '"designPlanJson"',
                    )
                      ? { designPlanJson: JSON.stringify(FAKE_DESIGN_PLAN) }
                      : {}),
                  }
                : intent.value
              : { schemaVersion: THEME_INTENT_SCHEMA_VERSION },
          },
        };
      }
      const intent = runFakeProvider(input);
      if (!intent.ok) return { kind: "invalid_json", usage: ZERO_USAGE };
      const draft = fakeDraft(intent.value, input.name);
      const explicit = request.system?.includes(
        "This build uses explicit style choices",
      );
      if (explicit) {
        const design = draft.design as Record<string, Record<string, unknown>>;
        const choices: Record<string, unknown> = {
          cart: "compact",
          storefront: "classic",
          gridColumnsDesktop: 3,
          cardHoverImage: false,
          headingCase: "none",
          primary: "solid",
          case: "none",
          tracking: "normal",
          gridGap: "standard",
        };
        for (const [group, keys] of Object.entries(REQUIRED_DESIGN_CHOICES))
          for (const key of keys)
            if (design[group][key] == null) design[group][key] = choices[key];
        for (const page of draft.pages as {
          sections: {
            type: string;
            configJson: string;
            style: Record<string, unknown>;
          }[];
        }[])
          for (const section of page.sections) {
            const config = JSON.parse(section.configJson);
            for (const [key, values] of Object.entries(
              VISIBLE_SECTION_CHOICES[section.type] ?? {},
            ))
              if (config[key] == null)
                config[key] = key === "height" ? "medium" : values[0];
            for (const item of config.slides ?? config.tiles ?? [])
              item.theme ??= "dark";
            section.configJson = JSON.stringify(config);
            section.style.padding ??= "md";
            section.style.width ??= "contained";
          }
      }
      // A v33 request's schema carries the templates as one JSON string, a
      // v32 one as the object; a pre-v32 request's schema has neither and no
      // announcement, and the answer must not either.
      const answerFields = (request.schema?.properties ?? {}) as object;
      // v34: the theme's own style rules, only where the schema asks.
      if (Object.hasOwn(answerFields, "stylesheetJson"))
        draft.stylesheetJson = JSON.stringify(FAKE_STYLESHEET);
      if (Object.hasOwn(answerFields, "templatesJson")) {
        draft.templatesJson = JSON.stringify(draft.templates);
        delete draft.templates;
      } else if (!Object.hasOwn(answerFields, "templates")) {
        delete draft.templates;
        delete draft.announcement;
      }
      if (
        Object.hasOwn(
          (request.schema?.properties ?? {}) as object,
          "composition",
        )
      ) {
        draft.composition = "editorial";
        draft.navigation = "collections";
        const design = draft.design as Record<string, unknown>;
        if (!explicit) {
          design.layoutOverridesJson = JSON.stringify(design.layout);
          delete design.layout;
        }
        delete draft.menus;
        delete draft.features;
        for (const product of draft.products as Record<string, unknown>[])
          delete product.variants;
      }
      if (hook("repair") && !isRepair) {
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: { ...draft, pages: [] },
        };
      }
      return { kind: "ok", usage: ZERO_USAGE, value: draft };
    },
  };
}
