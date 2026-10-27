// ---------------------------------------------------------------------------
// The offline planner: a deterministic raw site plan in the model's exact
// shape (site-schema.ts), for local development and the tests
// (MINK_REVAMP_PROVIDER=fake; docs/mink-storefront-revamp.md, section 14).
//
// ★ IT MUST COMPILE CLEAN. The point of a fake is that the rest of the job
//   (photos, products, review, apply) runs against a plan the strict
//   compiler accepts with zero issues, so every rule the compiler holds the
//   model to is followed here too: a full-band opening, a closing
//   newsletter, two colour bands that never touch, links only to targets,
//   every merchant section kept by id, the refill and category shots named
//   exactly as the compiler names them, one shot per image field, and a
//   storefront led by photographs (live-1: a three-slide opening carousel,
//   a gallery band, a photograph on every page).
//
// ★ ONLY THE MERCHANT'S WORDS. Copy is the brief, the merchant's facts and
//   the store facts, re-arranged; any other wording is fixed and plain, with
//   no claim word and no number. A label taken from the store (a category
//   name, a page address) is used only when it carries neither, or the
//   claim check would refuse a word the merchant never wrote.
//
// ★★ REAL GOODS OR NO GOODS (B16). A photograph shows the merchant's own
//   products, by key from the compiler's own list (`revampGoodsCatalogue`),
//   or a scene with no products at all: the first opening slide, two
//   gallery photos and each category's tile show the products when the
//   merchant has photographed ones; everything else is a setting, its
//   materials and its light.
//
// ★★ DISTINCT BY DEFAULT, LIKE A REAL PLAN (prompt v5). Every choice a model
//   makes is picked here with the seeded picker (`revampSeededPick`, seeded
//   by the store id and the redesign id): the design direction, its palette
//   (one of the direction's own page families), fonts, corners, header, card
//   and footer, one of three homepage structures, every section setting and
//   the neutral lines, so dry runs vary by store the way real ones do. The
//   answer names its prompt version, so it compiles under v5's rules.
//
// ★ PURE AND DETERMINISTIC. The same input gives the same answer.
// ---------------------------------------------------------------------------

import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  DESIGN_DIRECTION_IDS,
  DESIGN_DIRECTIONS,
  type DesignDirection,
  type PaletteFamily,
} from "@/lib/theme-studio/design-directions";
import { FONT_PAIRING_KEYS, FONT_PAIRINGS } from "@/lib/themes/fonts";
import { categorySlugFromName } from "../storefront-personalization-contract";
import type { RevampSitePlan, RevampSnapshot } from "./contract";
import {
  cleanRevampCopy,
  revampClaimEvidence,
  unsupportedClaimsIn,
} from "./copy-checks";
import {
  REVAMP_APPEARANCE_VARIANTS,
  REVAMP_HOME_SLUG,
  REVAMP_MAX_HEADER_LINKS,
  REVAMP_NEUTRAL_COPY,
  REVAMP_SECTION_TYPES,
  REVAMP_TEXT_LIMITS,
  isLightColour,
  normalizeRevampHex,
  revampCategoryBandAllowed,
  revampCategoryPhotoNeeds,
  revampCategoryShotId,
  revampDesignSeed,
  revampGoodsCatalogue,
  revampHasRealProducts,
  revampLinkTargets,
  revampNeutralLine,
  revampPageScope,
  revampRefillSlots,
  revampSeededPick,
  sanitizeShotId,
} from "./site-compiler";
import {
  REVAMP_SITE_PROMPT_VERSION,
  revampIndustryGuess,
  type RevampSiteInput,
} from "./site-schema";

interface RawStyle {
  scheme: string | null;
  padding: string | null;
  width: string | null;
}

interface RawSection {
  keep: string;
  type: string;
  configJson: string;
  style: RawStyle;
}

interface RawShot {
  id: string;
  purpose: "hero" | "content" | "category";
  /** ★★ Real goods or no goods (B16): the merchant's products, or none. */
  goods: "merchant" | "none";
  productKeys: string[];
  subject: string;
  artDirection: string;
  aspectRatio: string;
  people: "none";
  category: string | null;
}

interface RawLink {
  label: string;
  href: string;
  children: RawLink[];
}

/** One section on its way into a page, with what the scheme pass needs. */
interface Entry {
  raw: RawSection;
  kept: boolean;
  /** A kept section's own scheme (it is never changed). */
  keptScheme: string | null;
  enabled: boolean;
  /** True when a colour band suits it. */
  schemeable: boolean;
}

const NO_STYLE: RawStyle = { scheme: null, padding: null, width: null };

/**
 * The lights the offline planner writes into its one art direction, as a
 * model would describe its own shoot. ★ The planner's answer only: the
 * compiler's default art direction names no light (a photo look varied
 * across stores is step 9 of the robustness audit, which waits for the
 * owner's OK).
 */
export const FAKE_PLAN_LIGHTS = [
  "soft morning daylight",
  "warm late afternoon light",
  "clear, even daylight",
  "gentle window light from one side",
  "bright, airy daylight",
  "low golden evening light",
] as const;

// ★ One shoot for every picture, in plain words with no number in them: its
//   light picked for the store (`FAKE_PLAN_LIGHTS`), then the rest.
const ART_DIRECTION_REST =
  "the store's own palette, a simple uncluttered setting with a little texture, shot at eye level with a standard lens and a gently blurred background.";

type FakePalette = Record<
  | "cream"
  | "creamDeep"
  | "surface"
  | "ink"
  | "inkSoft"
  | "inkFaint"
  | "border"
  | "accent",
  string
>;

const fakePalette = (
  cream: string,
  creamDeep: string,
  surface: string,
  ink: string,
  inkSoft: string,
  inkFaint: string,
  border: string,
  accent: string,
): FakePalette => ({
  cream,
  creamDeep,
  surface,
  ink,
  inkSoft,
  inkFaint,
  border,
  accent,
});

/**
 * ★ Palettes that pass every legibility check the compiler runs, by the page
 * family each paints (design-directions.ts): on a light theme a light, a
 * tinted-neutral (sage, clay, mineral) or a colour-field page; on a dark
 * theme a near-black one or a deep-coloured one (the theme's polarity stays,
 * the compiler's rule). The tests compile every one of them clean.
 */
const LIGHT_PAGES: Partial<Record<PaletteFamily, readonly FakePalette[]>> = {
  light: [
    fakePalette(
      "#faf7f2",
      "#f0e9de",
      "#ffffff",
      "#1f1b16",
      "#4f473e",
      "#7d7468",
      "#e3dccf",
      "#7a4a2a",
    ),
    fakePalette(
      "#f6f7f5",
      "#e8ebe8",
      "#ffffff",
      "#1b1f1e",
      "#48504d",
      "#79817e",
      "#dce1de",
      "#2f5d50",
    ),
  ],
  "tinted-neutral": [
    fakePalette(
      "#dfe5d6",
      "#d2dac6",
      "#f4f6f0",
      "#1c211a",
      "#434b3f",
      "#6b7465",
      "#c3cdb6",
      "#4f6b3a",
    ),
    fakePalette(
      "#ead8c8",
      "#dfc8b4",
      "#f8f0e9",
      "#2a1d14",
      "#54402f",
      "#7c6553",
      "#d4bba5",
      "#9a4f2c",
    ),
    fakePalette(
      "#d9dfe2",
      "#cad2d6",
      "#f1f4f5",
      "#1a2024",
      "#424c53",
      "#6a757c",
      "#bcc6cb",
      "#3e5c6e",
    ),
  ],
  "colour-field": [
    fakePalette(
      "#f3e3a3",
      "#ead68a",
      "#fdf8e6",
      "#2a2410",
      "#51472a",
      "#776b49",
      "#dccb85",
      "#b0471f",
    ),
    fakePalette(
      "#f2d4cf",
      "#eac3bd",
      "#fcf1ef",
      "#2c1a18",
      "#573a36",
      "#7e5f5b",
      "#dfb7b0",
      "#a8364a",
    ),
    fakePalette(
      "#cfe2ee",
      "#bdd5e5",
      "#f0f6fa",
      "#13212b",
      "#3a4c59",
      "#63747f",
      "#b2cadb",
      "#1f5f8b",
    ),
  ],
};

const DARK_NEUTRAL_PAGES: readonly FakePalette[] = [
  fakePalette(
    "#15130f",
    "#1f1c17",
    "#26221c",
    "#f5f0e8",
    "#cdc4b6",
    "#9c9386",
    "#3b352c",
    "#d9a066",
  ),
  fakePalette(
    "#121417",
    "#1b1e22",
    "#23272c",
    "#eef1f4",
    "#c3c9d0",
    "#8f979f",
    "#343a41",
    "#9fc3e0",
  ),
];
const DARK_COLOURED_PAGES: readonly FakePalette[] = [
  fakePalette(
    "#14291f",
    "#1b3428",
    "#213d30",
    "#eef4ef",
    "#c4d3c8",
    "#93a699",
    "#2f4c3e",
    "#d8b25c",
  ),
  fakePalette(
    "#2a1424",
    "#351b2e",
    "#3e2236",
    "#f6edf3",
    "#d6c1cf",
    "#a48c9b",
    "#4d2f43",
    "#e6a15a",
  ),
];

/** The pages a direction's palette family is painted on, by the theme's polarity. */
function pagesFor(
  family: PaletteFamily,
  light: boolean,
): readonly FakePalette[] {
  if (light) return LIGHT_PAGES[family] ?? [];
  return family === "colour-field" ? DARK_COLOURED_PAGES : DARK_NEUTRAL_PAGES;
}

/** Corner radii a direction suits (its `styles`), one set picked per store. */
const RADII: Record<
  DesignDirection,
  ReadonlyArray<{ card: number; control: number; sm: number; pill: number }>
> = {
  "luxury-minimal": [
    { card: 0, control: 0, sm: 0, pill: 0 },
    { card: 2, control: 2, sm: 2, pill: 2 },
  ],
  "bold-and-loud": [
    { card: 4, control: 4, sm: 2, pill: 999 },
    { card: 0, control: 8, sm: 4, pill: 999 },
  ],
  "magazine-editorial": [
    { card: 0, control: 4, sm: 2, pill: 999 },
    { card: 6, control: 6, sm: 4, pill: 999 },
  ],
  "dense-catalogue": [
    { card: 6, control: 6, sm: 4, pill: 999 },
    { card: 8, control: 6, sm: 4, pill: 999 },
  ],
  "soft-and-natural": [
    { card: 16, control: 12, sm: 8, pill: 999 },
    { card: 20, control: 14, sm: 10, pill: 999 },
    { card: 12, control: 10, sm: 6, pill: 999 },
  ],
  "playful-and-colourful": [
    { card: 24, control: 24, sm: 12, pill: 999 },
    { card: 20, control: 20, sm: 10, pill: 999 },
  ],
  "classic-and-trusted": [
    { card: 8, control: 6, sm: 4, pill: 999 },
    { card: 10, control: 8, sm: 6, pill: 999 },
  ],
};

/** The homepage's three structures after its opening (the playbook's names). */
const STRUCTURES = ["discovery", "catalogue-first", "story-first"] as const;
type Structure = (typeof STRUCTURES)[number];

/** Two colour bands, never the same on neighbours, in an order picked per store. */
const SCHEME_ORDERS: ReadonlyArray<readonly string[]> = [
  ["soft", "tint"],
  ["tint", "soft"],
  ["soft", "inverse"],
  ["inverse", "soft"],
];

const POLICY_LABELS: Record<string, string> = {
  terms: "Terms",
  "refund-policy": "Refund policy",
  "shipping-policy": "Shipping policy",
  "privacy-policy": "Privacy policy",
};

// ---------------------------------------------------------------------------
// Text helpers.
// ---------------------------------------------------------------------------

/** At most `max` characters, cut between words (never inside a number). */
function clipWords(value: string, max: number): string {
  const words = cleanRevampCopy(value).replace(/\s+/g, " ").split(" ");
  let out = "";
  for (const word of words) {
    if (!word) continue;
    const next = out ? `${out} ${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out.replace(/[\s,;:]+$/, "");
}

/** The text ending in a full stop (or its own end mark). */
function sentence(value: string): string {
  const s = cleanRevampCopy(value);
  if (!s) return "";
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function humanize(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** What the compiler accepts as evidence for a claim word: the shared builder. */
function claimEvidence(input: RevampSiteInput): string {
  return revampClaimEvidence(input.request, input.snapshot);
}

/** A store-supplied label, or the fallback when it holds a claim or a number. */
function safeLabel(value: string, evidence: string, fallback: string): string {
  const s = cleanRevampCopy(value);
  if (!s || /\d/.test(s) || unsupportedClaimsIn(s, evidence).length > 0) {
    return fallback;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------

function newEntry(
  type: string,
  overrides: Record<string, unknown>,
  options: { schemeable?: boolean; style?: RawStyle } = {},
): Entry {
  const base = (EMPTY_CONFIG as unknown as Record<string, unknown>)[type];
  const config = {
    ...(base && typeof base === "object" ? (base as object) : {}),
    ...overrides,
  };
  return {
    raw: {
      keep: "",
      type,
      configJson: JSON.stringify(config),
      style: options.style ?? { ...NO_STYLE },
    },
    kept: false,
    keptScheme: null,
    enabled: true,
    schemeable: options.schemeable ?? false,
  };
}

function keptEntry(section: PageSectionItem): Entry {
  const type = (REVAMP_SECTION_TYPES as readonly string[]).includes(
    section.type,
  )
    ? section.type
    : "rich_text";
  return {
    raw: { keep: section.id, type, configJson: "", style: { ...NO_STYLE } },
    kept: true,
    keptScheme: section.style?.scheme ?? null,
    enabled: section.enabled !== false,
    schemeable: false,
  };
}

/** The merchant's own sections of a store page, as the compiler reads them. */
function merchantSections(
  page: RevampSnapshot["pages"][number] | null,
): PageSectionItem[] {
  if (!page) return [];
  return page.sections.filter(
    (s) => page.owners[s.id] === "merchant" || s.type === "custom_code",
  );
}

/**
 * Two colour bands (fewer when kept sections already wear some), never on
 * the opening and never the same scheme on two neighbours.
 */
function assignSchemes(
  entries: Entry[],
  wanted: number,
  schemes: readonly string[],
): void {
  const enabled = entries.filter((e) => e.enabled);
  const schemeOf = (e: Entry | undefined): string | null =>
    !e ? null : e.kept ? e.keptScheme : e.raw.style.scheme;
  const already = enabled.filter((e) => e.kept && e.keptScheme).length;
  let room = Math.min(Math.max(0, wanted - already), Math.max(0, 3 - already));
  let order: string[] = [...schemes];
  for (let i = 0; i < enabled.length && room > 0; i++) {
    const e = enabled[i];
    if (e.kept || !e.schemeable) continue;
    const prev = schemeOf(enabled[i - 1]);
    const next = schemeOf(enabled[i + 1]);
    const pick = order.find((s) => s !== prev && s !== next);
    if (!pick) continue;
    e.raw.style = { ...e.raw.style, scheme: pick, padding: "md" };
    order = [...order.filter((s) => s !== pick), pick];
    room -= 1;
  }
}

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

/** A raw site plan the strict compiler accepts, built from the input alone. */
export function fakeRevampSiteOutput(input: RevampSiteInput): unknown {
  const { request, snapshot } = input;
  const previous: RevampSitePlan | null =
    request.kind === "refine" ? (input.previous ?? null) : null;
  const scopeInput = { request, snapshot, previous };
  const store = snapshot.storeName.trim() || "Our shop";
  const business = cleanRevampCopy(request.brief.business) || store;
  const facts = request.brief.facts.map(sentence).filter(Boolean);
  const f = snapshot.facts;
  const evidence = claimEvidence(input);

  // ── Every choice, picked for this store and this redesign (v5) ─────────
  const seed = revampDesignSeed(snapshot.storeId, input.revampId);
  const choose = <T>(salt: string, options: readonly T[]): T =>
    revampSeededPick(`${seed}|fake|${salt}`, options);
  const themePage = normalizeRevampHex(snapshot.theme.palette.page);
  const light = themePage ? isLightColour(themePage) : true;
  const industry = revampIndustryGuess(request);
  // A direction made for the industry, with a page family this theme's
  // polarity can paint; then one of that family's palettes.
  const paintable = (id: DesignDirection) =>
    DESIGN_DIRECTIONS[id].palettes.some(
      (family) => pagesFor(family, light).length > 0,
    );
  const suited = DESIGN_DIRECTION_IDS.filter(
    (id) =>
      paintable(id) &&
      (DESIGN_DIRECTIONS[id].industries as readonly string[]).includes(
        industry,
      ),
  );
  const direction = choose(
    "direction",
    suited.length ? suited : DESIGN_DIRECTION_IDS.filter(paintable),
  );
  const family = choose(
    "family",
    DESIGN_DIRECTIONS[direction].palettes.filter(
      (candidate) => pagesFor(candidate, light).length > 0,
    ),
  );
  const themeAccent = normalizeRevampHex(snapshot.theme.palette.accent);
  const pagePalette = choose("palette", pagesFor(family, light));
  const look = {
    ...pagePalette,
    accent: themeAccent ?? pagePalette.accent,
  };
  const pairings = FONT_PAIRING_KEYS.filter((key) =>
    (FONT_PAIRINGS[key].directions as readonly string[]).includes(direction),
  );
  const fontPairing = choose(
    "fonts",
    pairings.length ? pairings : FONT_PAIRING_KEYS,
  );
  const structure: Structure = choose("structure", STRUCTURES);
  const lightWords = choose("light", FAKE_PLAN_LIGHTS);
  const artDirection = `${lightWords.charAt(0).toUpperCase()}${lightWords.slice(1)}, ${ART_DIRECTION_REST}`;
  // Words on the page itself read against it: dark on a light page.
  const pageWords = light ? "dark" : "light";
  const letter = {
    heading: choose("letter.heading", REVAMP_NEUTRAL_COPY.newsletterHeading),
    subtext: revampNeutralLine(
      choose("letter.subtext", REVAMP_NEUTRAL_COPY.newsletterSubtext),
      store,
    ),
    button: choose("letter.button", REVAMP_NEUTRAL_COPY.newsletterButton),
    thanks: choose("letter.thanks", REVAMP_NEUTRAL_COPY.newsletterThanks),
  };

  const scope = revampPageScope(scopeInput);
  const written = scope.pages.filter((p) => p.write);
  const targets = revampLinkTargets({
    request,
    snapshot,
    plan: {
      pages: scope.pages.map((p) => ({
        slug: p.slug,
      })) as RevampSitePlan["pages"],
    },
  });
  const hasProducts = revampHasRealProducts({ request, snapshot });
  const categoryBand = revampCategoryBandAllowed({ request, snapshot });

  // ★★ The products a photograph may show, the compiler's own list.
  const goods = revampGoodsCatalogue({ request, snapshot });
  const goodsKeys = [...goods.keys()];
  const namesOf = (keys: string[]) =>
    keys
      .map((key) => goods.get(key)?.name ?? "")
      .filter(Boolean)
      .join(" and ");
  /** A picture with no products in it: a setting, materials, light. */
  const scene = (what: string) =>
    `${what}, a scene for ${store} with no products in the picture`;

  const shots: RawShot[] = [];
  const shotIds = new Set<string>();
  const addShot = (
    base: string,
    purpose: RawShot["purpose"],
    subject: string,
    aspectRatio: string,
    category: string | null = null,
    productKeys: string[] = [],
  ): string => {
    let id = sanitizeShotId(base) ?? "photo";
    for (let n = 2; shotIds.has(id); n++)
      id = `${sanitizeShotId(base) ?? "photo"}-${n}`;
    shotIds.add(id);
    shots.push({
      id,
      purpose,
      goods: productKeys.length ? "merchant" : "none",
      productKeys: [...productKeys],
      subject: clipWords(subject, REVAMP_TEXT_LIMITS.shotSubject),
      artDirection,
      aspectRatio,
      people: "none",
      category,
    });
    return id;
  };
  /** One of the merchant's products, or a scene when they have none. */
  const goodsShot = (
    base: string,
    purpose: RawShot["purpose"],
    keys: string[],
    sceneSubject: string,
    aspectRatio: string,
  ): string =>
    keys.length
      ? addShot(
          base,
          purpose,
          `${namesOf(keys)}, from ${store}`,
          aspectRatio,
          null,
          keys,
        )
      : addShot(base, purpose, scene(sceneSubject), aspectRatio);
  const slot = (id: string) => `revamp-slot://${id}`;

  // Page titles, read once: the header, the footer and the pages agree.
  const titles = new Map<string, string>();
  for (const page of written) {
    if (page.slug === "") continue;
    const fallback = /contact/.test(page.slug)
      ? "Contact us"
      : /faq|question/.test(page.slug)
        ? "Questions"
        : "About us";
    const derived = /contact/.test(page.slug)
      ? "Contact us"
      : /faq|question/.test(page.slug)
        ? "Questions"
        : humanize(page.slug);
    titles.set(
      page.slug,
      clipWords(
        safeLabel(derived, evidence, fallback),
        REVAMP_TEXT_LIMITS.pageTitle,
      ),
    );
  }
  const aboutSlug = written.find(
    (p) => p.slug !== "" && /about|story/.test(p.slug),
  )?.slug;

  // ── Shared copy ────────────────────────────────────────────────────────
  const valuePoints: Array<{ icon: string; title: string; subtitle: string }> =
    [];
  for (const fact of facts.slice(0, 2)) {
    valuePoints.push({
      icon: "star",
      title: clipWords(fact, 80),
      subtitle: "",
    });
  }
  if (f.delivery) {
    valuePoints.push({
      icon: "truck",
      title: "Delivery",
      subtitle: clipWords(sentence(f.delivery), 120),
    });
  } else if (typeof f.freeDeliveryAbove === "number") {
    valuePoints.push({
      icon: "truck",
      title: `Free delivery over Rs ${f.freeDeliveryAbove}`,
      subtitle: "",
    });
  }
  if (f.returns) {
    valuePoints.push({
      icon: "refresh",
      title: "Returns",
      subtitle: clipWords(sentence(f.returns), 120),
    });
  }
  if (f.cashOnDelivery) {
    valuePoints.push({
      icon: "shield",
      title: "Cash on delivery",
      subtitle: "",
    });
  }
  if (f.onlinePayments) {
    valuePoints.push({ icon: "lock", title: "Pay online", subtitle: "" });
  }
  if (f.pickup) {
    valuePoints.push({
      icon: "clock",
      title: "Pick up in store",
      subtitle: "",
    });
  }
  const points = valuePoints.filter((p) => p.title).slice(0, 4);
  if (points.length === 0) {
    points.push({
      icon: "star",
      title: store,
      subtitle: clipWords(business, 120),
    });
  }

  const story = clipWords([sentence(business), ...facts].join(" "), 400);

  const faqItems: Array<{
    question: string;
    answer: string;
    category: string;
  }> = [];
  if (f.delivery) {
    faqItems.push({
      question: "How does delivery work?",
      answer: sentence(f.delivery),
      category: "",
    });
  }
  if (typeof f.freeDeliveryAbove === "number") {
    faqItems.push({
      question: "Is delivery free?",
      answer: `Delivery is free on orders over Rs ${f.freeDeliveryAbove}.`,
      category: "",
    });
  }
  if (f.returns) {
    faqItems.push({
      question: "Can I return an order?",
      answer: sentence(f.returns),
      category: "",
    });
  }
  if (f.cashOnDelivery) {
    faqItems.push({
      question: "Can I pay cash on delivery?",
      answer: "Yes, you can pay cash on delivery.",
      category: "",
    });
  }
  if (f.onlinePayments) {
    faqItems.push({
      question: "Can I pay online?",
      answer: "Yes, you can pay online at checkout.",
      category: "",
    });
  }
  if (f.pickup) {
    faqItems.push({
      question: "Can I collect my order?",
      answer: "Yes, you can pick up your order from the store.",
      category: "",
    });
  }
  faqItems.push({
    question: "How do I place an order?",
    answer:
      "Choose what you like in the shop, add it to your cart and check out.",
    category: "",
  });

  const faqEntry = (schemeable: boolean) =>
    newEntry(
      "faq_accordion",
      {
        heading: choose("faq.heading", [
          "Questions and answers",
          "Good to know",
          "Before you order",
          "Your questions",
        ]),
        subheading: "",
        items: faqItems,
        show_filters: choose("faq.filters", [true, false]),
      },
      { schemeable },
    );

  // ★ The homepage's story points at the About page when there is one; the
  //   About page's own story points at the shop, never at itself.
  const storyEntry = (shotId: string, onHome: boolean) =>
    newEntry(
      "media_text",
      {
        eyebrow: "Our story",
        heading: clipWords(`About ${store}`, 80),
        body: story,
        cta_label: onHome && aboutSlug ? "Read more" : "Visit the shop",
        cta_href: onHome && aboutSlug ? `/${aboutSlug}` : "/shop",
        image_url: slot(shotId),
        image_alt: clipWords(store, 120),
        media_position: choose("story.side", ["left", "right"]),
        media_ratio: choose("story.ratio", ["portrait", "square", "landscape"]),
        alignment: choose("story.alignment", ["left", "center"]),
        stories: [],
      },
      { schemeable: onHome },
    );

  // A page's photograph band: the page's own words beside one photograph.
  const photoBand = (slug: string, title: string) => {
    const shotId = addShot(
      `${slug}-photo`,
      "content",
      scene(`${title}: the place where ${store} works, in its own light`),
      "4:3",
    );
    return newEntry("media_text", {
      eyebrow: "",
      heading: clipWords(title, 80),
      body: clipWords(sentence(business), 400),
      cta_label: "Visit the shop",
      cta_href: "/shop",
      image_url: slot(shotId),
      image_alt: clipWords(store, 120),
      media_position: choose(`${slug}.side`, ["left", "right"]),
      media_ratio: choose(`${slug}.ratio`, ["portrait", "square", "landscape"]),
      alignment: choose(`${slug}.alignment`, ["left", "center"]),
      stories: [],
    });
  };

  // ── Pages ──────────────────────────────────────────────────────────────
  const pages = written.map((scopePage) => {
    const snap = scopePage.snapshotPage;
    const own = merchantSections(snap);
    const keptLetters = own.filter((s) => s.type === "newsletter");
    const keptOthers = own.filter((s) => s.type !== "newsletter");
    const entries: Entry[] = [];

    if (scopePage.slug === "") {
      // ★ The opening is a carousel of three photographs of one shoot, each
      //   its own shot (the prompt's rule, so the compiler's floor holds).
      const slideShots = [
        goodsShot(
          "home-hero",
          "hero",
          goodsKeys.slice(0, 2),
          "The setting of the shop, calm and uncluttered",
          "21:9",
        ),
        addShot(
          "home-hero-2",
          "hero",
          scene("The place where the shop works, its light and its materials"),
          "21:9",
        ),
      ];
      const slideCopy = [
        {
          heading: clipWords(store, 80),
          subheading: clipWords(sentence(business), 140),
        },
        {
          heading: choose("slide2.heading", [
            "Browse the shop",
            "See the range",
            "Have a look around",
          ]),
          subheading: clipWords(facts[0] ?? sentence(business), 140),
        },
        {
          heading: choose("slide3.heading", [
            "Find something you like",
            "Take a closer look",
            "Come and have a look",
          ]),
          subheading: clipWords(facts[1] ?? sentence(business), 140),
        },
      ];
      const slideWords = choose("slides.theme", ["light", "dark"]);
      const slideButton = choose("slides.cta", REVAMP_NEUTRAL_COPY.openingCta);
      entries.push(
        newEntry(
          "hero_carousel",
          {
            slides: slideShots.map((shotId, i) => ({
              ...slideCopy[i],
              cta_label: slideButton,
              cta_href: "/shop",
              image_url: slot(shotId),
              video_url: "",
              background: "",
              theme: slideWords,
            })),
            autoplay: choose("carousel.autoplay", [true, false]),
            interval_seconds: choose("carousel.interval", [4, 5, 6, 7, 8]),
            height: choose("carousel.height", ["large", "screen"]),
          },
          { style: { scheme: null, padding: null, width: "full" } },
        ),
      );
      const trustBar = newEntry(
        "usp_bar",
        { items: points, theme: pageWords },
        { schemeable: true },
      );
      const productBand = hasProducts
        ? newEntry("featured_products", {
            heading: choose("featured.heading", [
              "Shop the range",
              "In the shop",
              "Browse the range",
            ]),
            subheading: "",
            limit: choose("featured.limit", [4, 8, 12]),
          })
        : null;
      const categoryBandEntry = categoryBand
        ? newEntry("shop_by_category", {
            heading: choose("categories.heading", [
              "Shop by category",
              "Browse by category",
              "Find your way around",
            ]),
            subheading: "",
            layout: choose("categories.layout", ["scroll", "grid"]),
            display: choose("categories.display", ["circles", "cards", "list"]),
          })
        : null;
      const storyShot = addShot(
        "home-story",
        "content",
        scene("The workplace behind the shop: its tools, materials and light"),
        "4:5",
      );
      const storyBand = storyEntry(storyShot, true);
      // A band led by photographs: four of the same shoot.
      // ★ The first two show the merchant's products when there are any.
      const galleryShots = [1, 2, 3].map((n) =>
        goodsShot(
          `home-gallery-${n}`,
          "content",
          n <= 2 && goodsKeys[n - 1] ? [goodsKeys[n - 1]] : [],
          `A detail of the shop's materials and setting, photograph ${["one", "two", "three", "four"][n - 1]} of four`,
          "1:1",
        ),
      );
      const galleryBand = newEntry("gallery", {
        heading: choose("gallery.heading", [
          "A closer look",
          "In pictures",
          "Around the shop",
          "Up close",
        ]),
        subheading: "",
        items: galleryShots.map((shotId) => ({
          image_url: slot(shotId),
          image_alt: clipWords(store, 120),
          caption: "",
          href: "",
        })),
        layout: choose("gallery.layout", ["grid", "editorial"]),
        columns: choose("gallery.columns", [2, 3, 4]),
        image_ratio: choose("gallery.ratio", [
          "portrait",
          "square",
          "landscape",
        ]),
      });
      // ★ One of the playbook's three structures after the opening.
      const order: Record<Structure, Array<Entry | null>> = {
        discovery: [
          trustBar,
          productBand,
          categoryBandEntry,
          storyBand,
          galleryBand,
        ],
        "catalogue-first": [
          categoryBandEntry,
          productBand,
          galleryBand,
          trustBar,
          storyBand,
        ],
        "story-first": [
          storyBand,
          galleryBand,
          productBand,
          trustBar,
          categoryBandEntry,
        ],
      };
      entries.push(
        ...order[structure].filter((entry): entry is Entry => entry !== null),
      );
      entries.push(...keptOthers.map(keptEntry));
      entries.push(faqEntry(true));
      if (keptLetters.length === 0) {
        entries.push(
          newEntry("newsletter", {
            eyebrow: "",
            heading: letter.heading,
            subheading: letter.subtext,
            button_label: letter.button,
            success_message: letter.thanks,
            consent_text: "I agree to receive store news and offers by email.",
            theme: choose("letter.theme", ["light", "dark"]),
            alignment: choose("letter.alignment", ["left", "center"]),
          }),
        );
      }
      entries.push(...keptLetters.map(keptEntry));
      assignSchemes(entries, 2, choose("schemes", SCHEME_ORDERS));
    } else {
      const title = titles.get(scopePage.slug) ?? "About us";
      // ★ Every page the redesign writes carries a photograph (live-1).
      if (/faq|question/.test(scopePage.slug)) {
        entries.push(photoBand(scopePage.slug, title));
        entries.push(faqEntry(false));
      } else if (/contact/.test(scopePage.slug)) {
        entries.push(photoBand(scopePage.slug, title));
        const place = [f.city, f.state].filter(Boolean).join(", ");
        const html = [
          "<h2>Get in touch</h2>",
          place
            ? `<p>${escapeHtml(`We are based in ${place}.`)}</p>`
            : "<p>Write to us and we will reply as soon as we can.</p>",
          f.delivery ? `<p>${escapeHtml(sentence(f.delivery))}</p>` : "",
        ].join("");
        entries.push(newEntry("rich_text", { html, width: "contained" }));
      } else if (/about|story/.test(scopePage.slug)) {
        const shot = addShot(
          `${scopePage.slug}-photo`,
          "content",
          scene(
            "The workplace behind the shop: its tools, materials and light",
          ),
          "4:5",
        );
        entries.push(storyEntry(shot, false));
      } else {
        entries.push(photoBand(scopePage.slug, title));
      }
      entries.push(...keptOthers.map(keptEntry));
      entries.push(...keptLetters.map(keptEntry));
    }

    const title =
      scopePage.slug === ""
        ? clipWords(store, REVAMP_TEXT_LIMITS.pageTitle) || "Home"
        : (titles.get(scopePage.slug) ?? "About us");
    let seoDescription =
      scopePage.slug === ""
        ? clipWords(
            `${store}: ${sentence(business)}`,
            REVAMP_TEXT_LIMITS.seoDescription,
          )
        : clipWords(
            `${title} at ${store}. Browse the shop and find out more.`,
            REVAMP_TEXT_LIMITS.seoDescription,
          );
    if (seoDescription.length < REVAMP_TEXT_LIMITS.seoDescriptionMin) {
      seoDescription = clipWords(
        `Visit ${store} to browse the shop and find out more.`,
        REVAMP_TEXT_LIMITS.seoDescription,
      );
    }
    return {
      slug: scopePage.slug === "" ? REVAMP_HOME_SLUG : scopePage.slug,
      title,
      seoTitle: clipWords(
        scopePage.slug === "" ? store : `${title} | ${store}`,
        REVAMP_TEXT_LIMITS.seoTitle,
      ),
      seoDescription,
      sections: entries.map((e) => e.raw),
    };
  });

  // ── Shots the compiler names ───────────────────────────────────────────
  for (const refill of revampRefillSlots(scopeInput)) {
    if (shotIds.has(refill.shotId)) continue;
    shotIds.add(refill.shotId);
    shots.push({
      id: refill.shotId,
      purpose: "content",
      goods: "none",
      productKeys: [],
      subject: clipWords(scene(refill.context), REVAMP_TEXT_LIMITS.shotSubject),
      artDirection,
      aspectRatio: refill.ratio,
      people: "none",
      category: null,
    });
  }
  for (const need of revampCategoryPhotoNeeds({ request, snapshot })) {
    const id = revampCategoryShotId(need.slug);
    if (shotIds.has(id)) continue;
    shotIds.add(id);
    // ★ A category's tile shows its own photographed products, or none.
    const keys = goodsKeys
      .filter((key) => goods.get(key)?.categorySlug === need.slug)
      .slice(0, 2);
    shots.push({
      id,
      purpose: "category",
      goods: keys.length ? "merchant" : "none",
      productKeys: keys,
      subject: clipWords(
        keys.length
          ? `${need.name} at ${store}: ${namesOf(keys)}`
          : scene(`The ${need.name} category, shown by its materials`),
        REVAMP_TEXT_LIMITS.shotSubject,
      ),
      artDirection,
      aspectRatio: "1:1",
      people: "none",
      category: need.slug,
    });
  }

  // ── Menus ──────────────────────────────────────────────────────────────
  const categoryNames = new Map<string, string>();
  for (const c of snapshot.categories) categoryNames.set(c.slug, c.name);
  for (const change of request.categories) {
    if (change.action === "create") {
      const slug =
        (change.slug ?? "").trim() || categorySlugFromName(change.name);
      if (slug) categoryNames.set(slug, change.name);
    } else if (change.action === "update" && change.name) {
      categoryNames.set(change.slug, change.name);
    }
  }
  const categoryLinks: RawLink[] = [...targets.categories]
    .sort()
    .slice(0, 6)
    .map((slug) => ({
      // ★ The name, else the address in words, else a plain word: a label
      //   the claim check would refuse is never offered.
      label:
        [categoryNames.get(slug) ?? "", humanize(slug)]
          .map((value) => safeLabel(value, evidence, ""))
          .find(Boolean) || "Collection",
      href: `/collections/${slug}`,
      children: [],
    }));
  const pageLinks: RawLink[] = written
    .filter((p) => p.slug !== "")
    .map((p) => ({
      label: titles.get(p.slug) ?? "About us",
      href: `/${p.slug}`,
      children: [],
    }));
  const header: RawLink[] = [
    { label: "Home", href: "/", children: [] },
    { label: "Shop", href: "/shop", children: categoryLinks },
    ...pageLinks,
  ].slice(0, REVAMP_MAX_HEADER_LINKS);

  const leaf = (link: RawLink) => ({ label: link.label, href: link.href });
  const footerGroups: Array<{
    title: string;
    links: Array<{ label: string; href: string }>;
  }> = [
    {
      title: "Shop",
      links: [
        { label: "All products", href: "/shop" },
        ...categoryLinks.map(leaf),
      ],
    },
  ];
  if (pageLinks.length) {
    footerGroups.push({ title: "About", links: pageLinks.map(leaf) });
  }
  const policies = Object.keys(POLICY_LABELS)
    .filter((slug) => targets.pages.has(slug))
    .map((slug) => ({ label: POLICY_LABELS[slug], href: `/${slug}` }));
  if (policies.length)
    footerGroups.push({ title: "Policies", links: policies });

  // ── Look ───────────────────────────────────────────────────────────────
  // (picked for the store above: the direction, its page and the fonts)

  const announcement =
    typeof f.freeDeliveryAbove === "number"
      ? {
          text: `Free delivery on orders over Rs ${f.freeDeliveryAbove}`,
          href: "/shop",
        }
      : f.cashOnDelivery
        ? { text: "Cash on delivery available", href: "/shop" }
        : { text: "", href: "" };

  // ★ The summary tells the merchant what their shoppers now see, homepage
  //   first, in "you" and "your" (live-4). No store name: an unnamed store
  //   would read "Our shop".
  // ★ In the order the homepage's structure shows them.
  const part = {
    products: hasProducts ? "your products" : "",
    categories: categoryBand ? "your categories" : "",
    story: "a short story",
    gallery: "a gallery of three photographs",
  };
  const partOrder: Record<Structure, Array<keyof typeof part>> = {
    discovery: ["products", "categories", "story", "gallery"],
    "catalogue-first": ["categories", "products", "gallery", "story"],
    "story-first": ["story", "gallery", "products", "categories"],
  };
  const homeParts = partOrder[structure]
    .map((key) => part[key])
    .filter(Boolean);
  const listed =
    homeParts.length > 1
      ? `${homeParts.slice(0, -1).join(", ")} and ${homeParts[homeParts.length - 1]}`
      : homeParts[0];
  const otherPages = written.some((p) => p.slug !== "");
  const homeWritten = written.some((p) => p.slug === "");
  const summary = homeWritten
    ? `Your homepage now opens on two photographs, then ${listed}.${otherPages ? " Every other page now carries a new photograph too." : ""}`
    : "Your pages now each carry a new photograph beside your own words.";

  return {
    // ★ The prompt version this answer follows (the schema asks for it), so
    //   the compiler holds it to v5's rules.
    promptVersion: REVAMP_SITE_PROMPT_VERSION,
    summary: clipWords(summary, REVAMP_TEXT_LIMITS.summary),
    industry,
    direction,
    design: {
      palette: look,
      fontPairing,
      radii: { ...choose("radii", RADII[direction]) },
    },
    appearance: {
      header: choose("header", REVAMP_APPEARANCE_VARIANTS.header),
      card: choose("card", REVAMP_APPEARANCE_VARIANTS.card),
      productDetail: choose(
        "productDetail",
        REVAMP_APPEARANCE_VARIANTS.productDetail,
      ),
      footer: choose("footer", REVAMP_APPEARANCE_VARIANTS.footer),
    },
    announcement,
    brand: {
      tagline:
        clipWords(sentence(business), REVAMP_TEXT_LIMITS.tagline) ||
        clipWords(store, REVAMP_TEXT_LIMITS.tagline),
      blurb: clipWords(
        [sentence(business), ...facts].join(" "),
        REVAMP_TEXT_LIMITS.blurb,
      ),
    },
    newsletter: {
      heading: letter.heading,
      subtext: clipWords(letter.subtext, REVAMP_TEXT_LIMITS.newsletterSubtext),
      buttonLabel: letter.button,
    },
    pages,
    menus: { header, footerGroups },
    shots,
    productCopy: request.products
      .filter((p) => cleanRevampCopy(p.description))
      .map((p) => ({
        key: p.key,
        description: clipWords(p.description, REVAMP_TEXT_LIMITS.productCopy),
      })),
    // ★ No `notes`: the schema asks for none (L2-G), and the fake answers in
    //   the schema's shape.
  };
}
