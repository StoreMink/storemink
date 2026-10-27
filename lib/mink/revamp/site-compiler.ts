import { REVAMP_WORK_BUDGET } from "./pacing-policy";
// ---------------------------------------------------------------------------
// The storefront revamp's site compiler: the model's raw site plan in, a
// validated `RevampSitePlan` out (docs/mink-storefront-revamp.md, sections 5
// and 7; the build spec's section 4 conventions).
//
// Two entry points over ONE builder, so the two can never disagree about a
// rule:
//
//   compileRevampSite   strict. Every problem is a plain sentence naming the
//                       page, the section and the field, so one repair call
//                       can fix all of them; a plan comes back only when
//                       there are none.
//   finalizeRevampSite  lenient. The same rules, each problem fixed
//                       mechanically (drop, replace, clear, move) and noted
//                       for the merchant; it throws `plan_invalid` only when
//                       nothing usable is left (no homepage, no pages).
//
// ★ THE BUILDER ALWAYS FIXES AND ALWAYS RECORDS. A strict run applies the
//   same fix a lenient run would, so a later rule judges cleaned data and
//   one mistake never cascades into five sentences the model cannot act on.
//   Strict returns the sentences; lenient returns the fixed plan and its
//   notes.
//
// ★ SOME THINGS ARE FIXED SILENTLY IN BOTH MODES: long dashes, the
//   opening's band width and height, a scheme with no padding, a shot's
//   aspect ratio and purpose, one art direction for the shoot. A repair call
//   is minutes of HIGH thinking; spending one on a value only one answer
//   could have is waste. Everything that needs the model's judgement (copy,
//   links, missing structure) is an issue.
//
// ★★ THE MERCHANT'S SECTIONS ARE NEVER DROPPED. A section the snapshot marks
//   `merchant` is kept by id, word for word; only a theme or earlier Mink
//   photo inside it is replaced (a refill shot). One the model forgot is put
//   back, before a closing newsletter.
//
// ★ PURE RULES. No database, no files, no environment, no server import:
//   `RevampStepError` comes from step-error.ts, so the runner can still
//   recognise it by class.
// ---------------------------------------------------------------------------

import { cleanNavTree, NAV_LIMITS, type NavLink } from "@/lib/chrome/nav";
import type { FooterGroup, StorefrontAppearance } from "@/lib/chrome/types";
import {
  contrastIssuesFor,
  contrastRatio,
  DESIGN_MIN_CONTRAST,
  DESIGN_PALETTE_TOKENS,
  DESIGN_PILL_MAX,
  DESIGN_RADIUS_MAX,
  DESIGN_SHAPE_KEYS,
  type DesignPaletteToken,
  type DesignShapeKey,
  type StorefrontDesignOverrides,
} from "@/lib/chrome/design";
import { IMAGE_SPECS, specForRatio } from "@/lib/media/image-specs";
import {
  clampLimit,
  EMPTY_CONFIG,
  HERO_HEIGHTS,
  HERO_VARIANTS,
  HOMEPAGE_SECTION_TYPES,
  MAX_PAGE_SECTIONS,
  SECTION_BLOCKS,
  USP_ICONS,
  validateConfig,
  validatePageSlug,
  validateSectionStyle,
  type HomepageSectionType,
  type PageSectionItem,
  type SectionStyle,
} from "@/lib/sections/registry";
import {
  DESIGN_DIRECTION_IDS,
  DESIGN_DIRECTIONS,
  type DesignDirection,
  type PaletteFamily,
} from "@/lib/theme-studio/design-directions";
import {
  colourBand,
  paletteFamilyIssues,
} from "@/lib/theme-studio/fingerprint";
import {
  aspectValue,
  THEME_IMAGE_ASPECT_RATIOS,
} from "@/lib/theme-studio/image-provider";
import {
  LAYOUT_VARIANT_ENUMS,
  PRODUCT_DETAIL_ENUM,
} from "@/lib/theme-studio/schemas";
import { sameJson } from "@/lib/themes/canonical-json";
import { FONT_PAIRINGS, isFontPairingKey } from "@/lib/themes/fonts";
import { INDUSTRY_LABELS, type ThemeIndustry } from "@/lib/themes/meta";
import {
  isSectionScheme,
  mixHex,
  SCHEME_MIX,
  schemeContrast,
  type SectionScheme,
} from "@/lib/themes/schemes";
import { withoutLongDashes } from "@/lib/text/long-dashes";
import { isMinkAiMadePhotoUrl } from "../media-generation-contract";
import {
  categorySlugFromName,
  isThemePhotoUrl,
} from "../storefront-personalization-contract";
import {
  REVAMP_LIMITS,
  REVAMP_SHOT_MAX_PRODUCT_KEYS,
  REVAMP_SKIPPED_SLUGS,
  REVAMP_SLOT_PREFIX,
  type RevampPlanBasis,
  type RevampPlannedPage,
  type RevampRequest,
  type RevampShot,
  type RevampShotPurpose,
  type RevampSitePlan,
  type RevampSlotBinding,
  type RevampSnapshot,
  type RevampSnapshotPage,
  type RevampSnapshotProduct,
} from "./contract";
import {
  cleanRevampCopy,
  isEnglish,
  readsAsLanguage,
  revampClaimEvidence,
  revampStoreNames,
  unsupportedClaimsIn,
  withoutStoreNames,
  withoutUnsupportedClaims,
} from "./copy-checks";
import type { RevampCompileResult } from "./ports";
import { RevampStepError } from "./step-error";

// ---------------------------------------------------------------------------
// The vocabulary a revamp writes in.
// ---------------------------------------------------------------------------

/**
 * Section types a revamp may ADD. Everything renderable except custom code
 * (never written by Mink), blog feeds (a store may have no posts) and video
 * (the photo pipeline draws stills), and except the sections whose whole
 * content is a claim the merchant would have to supply: testimonials, logos
 * (press marks), a countdown (a real date), a comparison (real figures),
 * before/after and hotspots (real photographs of a result or a scene).
 * ★ A merchant's own section of an excluded type is still KEPT; this list
 *   only says what the model may create.
 */
export const REVAMP_SECTION_TYPES = HOMEPAGE_SECTION_TYPES.filter(
  (type) =>
    type !== "custom_code" &&
    type !== "testimonials" &&
    type !== "logo_strip" &&
    type !== "countdown" &&
    type !== "comparison" &&
    type !== "before_after" &&
    type !== "image_hotspots" &&
    type !== "video" &&
    type !== "latest_blogs",
) as readonly HomepageSectionType[];

/** Header, card, product-page and footer styles a revamp may choose. */
export const REVAMP_APPEARANCE_VARIANTS = {
  header: LAYOUT_VARIANT_ENUMS.header,
  card: LAYOUT_VARIANT_ENUMS.card,
  productDetail: PRODUCT_DETAIL_ENUM,
  footer: LAYOUT_VARIANT_ENUMS.footer,
} as const;

/** Every industry the playbooks know, in the registry's order. */
export const REVAMP_INDUSTRIES = Object.keys(
  INDUSTRY_LABELS,
) as ThemeIndustry[];

/** Section paddings a revamp may set ("none" is the page gap alone). */
export const REVAMP_SECTION_PADDINGS = ["sm", "md", "lg"] as const;
export const REVAMP_SECTION_WIDTHS = ["contained", "full"] as const;

/** How the model names the homepage; the plan stores "". */
export const REVAMP_HOME_SLUG = "home";

/** The most top-level header links a revamped header carries. */
export const REVAMP_MAX_HEADER_LINKS = 7;

/** Field limits the compiler holds plan text to (characters). */
export const REVAMP_TEXT_LIMITS = {
  summary: 400,
  pageTitle: 80,
  seoTitle: 70,
  seoDescriptionMin: 20,
  seoDescription: 160,
  announcement: 160,
  tagline: 80,
  blurb: 300,
  newsletterHeading: 80,
  newsletterSubtext: 160,
  newsletterButton: 30,
  productCopy: 1500,
  note: 240,
  shotSubject: 600,
  artDirection: 600,
} as const;

/**
 * ★ ONE ITEM OF EACH LIST A NEW SECTION HOLDS, FIELD FOR FIELD (output-1).
 *   EMPTY_CONFIG starts these lists empty, so the prompt showed a section's
 *   own fields and never its items': the model guessed ("image" for a
 *   gallery photo, "items" for a tile grid's tiles), publish validation
 *   dropped every item, the section went and its shots went with it, and the
 *   photo floor asked again for photographs it could not get. The fields are
 *   exactly the ones `validateConfig` keeps (site-schema.test.ts holds the
 *   two equal); the values are neutral: "" for words, links and photos, the
 *   default for a choice. A list whose EMPTY_CONFIG already shows an item
 *   (carousel slides, the trust bar's items, the ticker's lines) needs none.
 */
export const REVAMP_LIST_ITEM_EXAMPLES: Readonly<
  Partial<Record<HomepageSectionType, Readonly<Record<string, string>>>>
> = {
  tile_grid: {
    title: "",
    subtitle: "",
    href: "",
    image_url: "",
    background: "",
    theme: "dark",
  },
  media_text: {
    eyebrow: "",
    heading: "",
    body: "",
    cta_label: "",
    cta_href: "",
    image_url: "",
    image_alt: "",
    media_position: "right",
  },
  gallery: { image_url: "", image_alt: "", caption: "", href: "" },
  faq_accordion: { question: "", answer: "", category: "" },
  accordion: {
    type: "text",
    heading: "",
    body: "",
    image_url: "",
    image_alt: "",
  },
  multicolumn: {
    icon: "",
    image_url: "",
    image_alt: "",
    heading: "",
    body: "",
    cta_label: "",
    cta_href: "",
  },
  image_marquee: { image_url: "", image_alt: "", href: "" },
};

/**
 * A section type's example config as the prompt shows it: EMPTY_CONFIG, with
 * one item in its list when EMPTY_CONFIG leaves the list empty.
 */
export function revampSectionExample(
  type: HomepageSectionType,
): Record<string, unknown> {
  const example = clone(EMPTY_CONFIG[type]) as unknown as Record<
    string,
    unknown
  >;
  const spec = SECTION_BLOCKS[type];
  const item = REVAMP_LIST_ITEM_EXAMPLES[type];
  if (spec && item) {
    const list = example[spec.key];
    if (!Array.isArray(list) || list.length === 0) {
      example[spec.key] = [{ ...item }];
    }
  }
  return example;
}

// ---------------------------------------------------------------------------
// ★★ DISTINCT BY DEFAULT (prompt v5; robustness audit, section 5, step 1).
//    The audit found 62 of 70 layout choices (89%) equal to the one value the
//    prompt's examples printed, and every left-out choice filled with the same
//    global default, so two shops on one theme came out alike. From v5 the
//    examples print each choice as "choose one: ..." and each word as an
//    instruction, and a choice the answer leaves out is picked for THAT store
//    (`revampSeededPick`, seeded by the store id and the redesign id) from the
//    same closed list, never one value for everyone.
// ★★ A PLAN ANSWERED UNDER v4 COMPILES EXACTLY AS BEFORE. The v5 schema asks
//    the answer to name its prompt version (`promptVersion`); an answer that
//    names none was planned under v4 (no job records the version), and every
//    rule below is switched off for it (`Ctx.v5`).
// ---------------------------------------------------------------------------

/**
 * The first prompt version whose answers carry closed choices, seeded
 * fallbacks, the page colour fitted to the direction and no copied
 * instruction (site-schema.ts REVAMP_SITE_PROMPT_VERSION).
 */
export const REVAMP_SEEDED_PROMPT_VERSION = 5;

/**
 * The prompt version an answer names (`promptVersion`, "mink-revamp-site-v5"),
 * as a number, or null when it names none: an answer planned under v4 or
 * earlier, which compiles as it always did.
 */
export function revampAnswerPromptVersion(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const match = /^mink-revamp-site-v(\d{1,3})$/.exec(
    text(raw.promptVersion).trim(),
  );
  return match ? Number(match[1]) : null;
}

/** 32-bit FNV-1a with a final mix, so seeds a letter apart land far apart. */
function seedHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * ★★ ONE OPTION OF A CLOSED LIST, PICKED FOR A STORE. The same seed always
 * picks the same option; different stores (and the same store's next
 * redesign) spread over the whole list. Seed it with `revampDesignSeed` and a
 * salt naming the choice ("<seed>|direction"), so two choices of one store
 * are picked independently. Pure: no clock, no randomness.
 */
export function revampSeededPick<T>(seed: string, options: readonly T[]): T {
  if (options.length === 0) {
    throw new RangeError("A seeded pick needs at least one option.");
  }
  return options[seedHash(seed) % options.length];
}

/**
 * The options in the order a store's prompt lists them: the list turned to
 * start at a seeded place, so no option is always first (a model leans
 * toward the first of a list it was shown).
 */
export function revampSeededOrder<T>(seed: string, options: readonly T[]): T[] {
  if (options.length === 0) return [];
  const start = seedHash(seed) % options.length;
  return [...options.slice(start), ...options.slice(0, start)];
}

/**
 * The seed of one redesign: its store and, when the caller has it, the
 * redesign's own id, so a redo of the same store picks again.
 */
export function revampDesignSeed(
  storeId: string,
  revampId?: string | null,
): string {
  return revampId ? `${storeId}:${revampId}` : storeId;
}

/** How a printed example offers a choice: "choose one: left or right". */
export const REVAMP_CHOOSE_PREFIX = "choose one:";

/**
 * How a printed example asks for words: "write in English: a heading in this
 * store's own words". In the brief's own language when the merchant insisted
 * on one (owner's rule: English unless asked again).
 */
export function revampWritePrefix(language: string): string {
  return isEnglish(language)
    ? "write in English:"
    : "write in the brief's language:";
}

const EXAMPLE_INSTRUCTION =
  /^\s*(write(?:\s+in\s+(?:english|the brief's language))?|choose\s+one)\s*:/i;

/**
 * True for text that is one of the printed examples' instructions, copied
 * into the answer instead of the store's own words ("write in English: ...",
 * "choose one: ...").
 */
export function isRevampExampleInstruction(value: string): boolean {
  return EXAMPLE_INSTRUCTION.test(value);
}

/**
 * The instruction a copied value starts with, in the prompt's own words
 * ("write in English:", "choose one:"): never anything written after it.
 */
export function revampExampleInstructionPrefix(value: string): string {
  const found = EXAMPLE_INSTRUCTION.exec(value);
  if (!found) return "";
  const words = found[1].toLowerCase().replace(/\s+/g, " ");
  return `${words.replace("english", "English")}:`;
}

/** A choice's value: a word, a number or true/false. */
export type RevampChoiceValue = string | number | boolean;

/**
 * One closed choice of a section setting. `options` is what the prompt
 * offers and what a fallback picks from; a value the validator also accepts
 * and a plan may keep as it is: `range` for a number (whole numbers within
 * it), `also` for a word.
 */
export interface RevampChoice {
  options: readonly RevampChoiceValue[];
  range?: readonly [number, number];
  also?: readonly string[];
}

const choice = (
  options: readonly RevampChoiceValue[],
  extra: Omit<RevampChoice, "options"> = {},
): RevampChoice => ({ options, ...extra });

const TEXT_THEMES = ["light", "dark"] as const;
const RATIOS = ["portrait", "square", "landscape"] as const;
const SPEEDS = ["slow", "medium", "fast"] as const;
const SIZES = ["sm", "md", "lg"] as const;
const COLUMNS = [2, 3, 4] as const;
const ON_OFF = [true, false] as const;

/**
 * ★★ EVERY VISIBLE SETTING A NEW SECTION CHOOSES, AS A CLOSED LIST: the
 * audit's checklist of the 62 values copied from the examples (21 settings
 * of the sections, plus the slides' and tiles' text colour, the stories'
 * sides, the trust bar's icons and a row's kind). Each list is a subset of
 * what the validator accepts (lib/homepage/section-types.ts) and of Theme
 * Studio's own visible choices (style-choices.ts), which the tests hold.
 * ★ What the compiler decides is not a choice and is not printed: a product
 *   band's and a category band's source and ids, and the trust bar's and the
 *   ticker's text colour (`revampTextThemeFor`: their words sit on the page,
 *   so the page decides).
 */
export const REVAMP_SECTION_CHOICES: Readonly<
  Partial<
    Record<
      HomepageSectionType,
      {
        fields?: Readonly<Record<string, RevampChoice>>;
        items?: Readonly<Record<string, RevampChoice>>;
      }
    >
  >
> = {
  hero: {
    fields: {
      variant: choice(HERO_VARIANTS),
      height: choice(["medium", "large", "screen"], { also: HERO_HEIGHTS }),
      theme: choice(TEXT_THEMES),
      alignment: choice(["left", "center"]),
    },
  },
  hero_carousel: {
    fields: {
      height: choice(["large", "screen"], { also: HERO_HEIGHTS }),
      autoplay: choice(ON_OFF),
      interval_seconds: choice([4, 5, 6, 7, 8], { range: [2, 15] }),
    },
    items: { theme: choice(TEXT_THEMES) },
  },
  featured_products: {
    fields: { limit: choice([4, 8, 12], { range: [1, 12] }) },
  },
  shop_by_category: {
    fields: {
      layout: choice(["scroll", "grid"]),
      display: choice(["circles", "cards", "list"]),
    },
  },
  promo_banner: {
    fields: {
      alignment: choice(["left", "center", "right"]),
      theme: choice(TEXT_THEMES),
    },
  },
  tile_grid: {
    fields: { columns: choice(COLUMNS), height: choice(SIZES) },
    items: { theme: choice(TEXT_THEMES) },
  },
  media_text: {
    fields: {
      media_position: choice(["left", "right"]),
      media_ratio: choice(RATIOS),
      alignment: choice(["left", "center"]),
    },
    items: { media_position: choice(["left", "right"]) },
  },
  gallery: {
    fields: {
      layout: choice(["grid", "editorial"]),
      columns: choice(COLUMNS),
      image_ratio: choice(RATIOS),
    },
  },
  newsletter: {
    fields: {
      theme: choice(TEXT_THEMES),
      alignment: choice(["left", "center"]),
    },
  },
  usp_bar: { items: { icon: choice(USP_ICONS) } },
  ticker: { fields: { speed: choice(SPEEDS) } },
  faq_accordion: { fields: { show_filters: choice(ON_OFF) } },
  accordion: {
    fields: { open_first: choice(ON_OFF), allow_multiple: choice(ON_OFF) },
    items: { type: choice(["text", "image"]) },
  },
  multicolumn: {
    fields: {
      columns: choice(COLUMNS),
      alignment: choice(["left", "center"]),
      image_ratio: choice(RATIOS),
    },
  },
  image_marquee: {
    fields: {
      speed: choice(SPEEDS),
      size: choice(SIZES),
      image_ratio: choice(RATIOS),
    },
  },
  product_spotlight: {
    fields: {
      media_position: choice(["left", "right"]),
      show_price: choice(ON_OFF),
    },
  },
  rich_text: { fields: { width: choice(["contained", "full"]) } },
};

/**
 * Section fields the compiler sets whatever the answer says (a product
 * band's and a category band's source and ids, `buildNewSection`), so the
 * prompt's examples leave them out.
 */
export const REVAMP_COMPILER_SET_FIELDS: Readonly<
  Partial<Record<HomepageSectionType, readonly string[]>>
> = {
  featured_products: ["source", "product_ids", "category_id"],
  shop_by_category: ["source", "category_ids"],
  product_spotlight: ["source", "product_id"],
  usp_bar: ["theme"],
  ticker: ["theme"],
};

/**
 * ★ The value of a choice as an answer wrote it, when it is one the validator
 * keeps: an option, a whole number within `range`, a word in `also`; "3" for
 * a number, "true" for true and "Left" for left are read as meant. Undefined
 * when it is none of them (left out, or the example's "choose one: ..."
 * copied), so the caller picks one for the store.
 */
function readChoice(
  value: unknown,
  rule: RevampChoice,
): RevampChoiceValue | undefined {
  const { options } = rule;
  if (options.includes(value as RevampChoiceValue)) {
    return value as RevampChoiceValue;
  }
  if (options.every((option) => typeof option === "number")) {
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : Number.NaN;
    if (!Number.isInteger(n)) return undefined;
    if (options.includes(n)) return n;
    return rule.range && n >= rule.range[0] && n <= rule.range[1]
      ? n
      : undefined;
  }
  if (options.every((option) => typeof option === "boolean")) {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  if (options.includes(word)) return word;
  return rule.also?.includes(word) ? word : undefined;
}

/**
 * ★★ NEUTRAL ENGLISH LINES FOR COPY THE ANSWER LEFT OUT (v5): picked for the
 * store, never one line for every store. Each one passes the claim checks
 * with no evidence at all, carries no number and no long dash, and makes no
 * promise the merchant did not (the tests hold every line to that).
 */
export const REVAMP_NEUTRAL_COPY = {
  /** The opening's button when the compiler writes the opening itself. */
  openingCta: [
    "Shop now",
    "Browse the shop",
    "See the range",
    "Visit the shop",
    "Explore the shop",
    "Start shopping",
  ],
  /** The header's one link when the answer left the header empty. */
  shopLink: ["Shop", "Shop all", "The shop", "Browse"],
  newsletterHeading: [
    "Stay in touch",
    "Hear from us",
    "Keep in touch",
    "Join the list",
    "News by email",
    "Letters from the shop",
  ],
  /**
   * `{store}` is the shop's name. ★ No line says how often mail comes
   * ("occasional", "now and then"): it sits beside the shopper's consent,
   * and how often a store emails is the merchant's to say.
   */
  newsletterSubtext: [
    "News from {store} by email.",
    "Hear from {store} by email.",
    "The latest from {store}, by email.",
    "Updates from {store}, sent by email.",
  ],
  newsletterButton: ["Subscribe", "Sign up", "Join", "Keep me posted"],
  newsletterThanks: [
    "Thank you for signing up.",
    "Thank you, you are on the list.",
    "Thanks for joining.",
    "You are on the list. Thank you.",
  ],
  /** The end of a search description the compiler completes. */
  seoTail: [
    "Browse the shop and find out more.",
    "See the shop and find out more.",
    "Find out more and browse the shop.",
    "Take a look around the shop.",
    "Visit the shop to find out more.",
  ],
} as const;

/** A neutral line with the shop's name in it. */
export function revampNeutralLine(line: string, storeName: string): string {
  return line.replace(/\{store\}/g, storeName);
}

/**
 * What each design direction's photographs feel like, for the image
 * direction's mood (`revampImageMood`): two picked for the store beside the
 * direction's own name. ★ Held for the owner's step 9 decision (below).
 */
const DIRECTION_MOODS: Record<DesignDirection, readonly string[]> = {
  "luxury-minimal": [
    "quiet",
    "refined",
    "spare",
    "precise",
    "calm",
    "polished",
  ],
  "bold-and-loud": ["energetic", "graphic", "confident", "vivid", "direct"],
  "magazine-editorial": [
    "editorial",
    "considered",
    "composed",
    "elegant",
    "curious",
  ],
  "dense-catalogue": ["clear", "practical", "bright", "orderly", "crisp"],
  "soft-and-natural": ["calm", "tactile", "earthy", "gentle", "unhurried"],
  "playful-and-colourful": [
    "cheerful",
    "bright",
    "lively",
    "friendly",
    "sunny",
  ],
  "classic-and-trusted": ["clear", "warm", "familiar", "steady", "welcoming"],
};

/**
 * The hue sectors `colourBand` names (0 to 5, sixty degrees each from red),
 * in words.
 */
const HUE_WORDS = [
  "warm red, orange and gold",
  "olive and sage green",
  "green and mint",
  "teal and sky blue",
  "blue and violet",
  "plum and rose",
] as const;

/** A colour in the words a photographer would use, from its band. */
function colourWords(hex: string): string {
  const band = colourBand(hex);
  if (band === "near-white") return "clean, light";
  if (band === "near-black") return "deep, near black";
  if (band === "neutral-light") return "soft, light neutral";
  if (band === "neutral-mid") return "muted grey";
  const [tone, sector] = band.split(":");
  const hue = HUE_WORDS[Number(sector)] ?? "neutral";
  return tone === "tinted"
    ? `pale ${hue}`
    : tone === "dark"
      ? `deep ${hue}`
      : hue;
}

/**
 * ★★ THE SHOOT'S MOOD AND PALETTE DIRECTION, PICKED FOR THE STORE (v5). The
 * photos step sends every redesign "Mood: <direction name>" and an empty
 * palette direction, so two stores of one direction ask the image model for
 * the same thing. The mood here is the direction's name and two of its mood
 * words picked for the store; the palette direction describes the page and
 * accent the design really has.
 * ★★ HELD, NOT WIRED (review fix, 25 Oct): a photo look varied across stores
 *   is step 9 of the robustness audit (photo style choices), which waits for
 *   the owner's OK. Nothing calls this, and `photos.ts`
 *   (`revampImageDirection`) is not to call it until the owner approves step
 *   9; the palette line alone, which follows the design's own colours, is
 *   part of that same decision.
 */
export function revampImageMood(input: {
  direction: string;
  /** The design's page and accent colours (the theme's where it keeps them). */
  page: string;
  accent: string;
  seed: string;
}): { moodKeywords: string[]; paletteDirection: string } {
  const known = (DESIGN_DIRECTION_IDS as readonly string[]).includes(
    input.direction,
  )
    ? (input.direction as DesignDirection)
    : null;
  const words = known
    ? revampSeededOrder(`${input.seed}|mood`, DIRECTION_MOODS[known])
    : [];
  const moodKeywords = [
    ...(known ? [DESIGN_DIRECTIONS[known].label] : []),
    ...words.slice(0, 2),
  ];
  const page = normalizeRevampHex(input.page);
  const accent = normalizeRevampHex(input.accent);
  const paletteDirection =
    page && accent
      ? `A ${colourWords(page)} page field with ${colourWords(accent)} accents, kept in every photograph.`
      : "";
  return { moodKeywords, paletteDirection };
}

/**
 * True when a page colour suits a design direction: one of the direction's
 * palette families (design-directions.ts) accepts it, by Theme Studio's own
 * rule (`paletteFamilyIssues`, fingerprint.ts): a tinted-neutral page is never
 * a near-white one, a colour-field page is coloured itself, a dark page is
 * dark. An unknown direction asks nothing.
 */
export function revampPageFitsDirection(
  direction: string,
  page: string,
): boolean {
  const known = (
    DESIGN_DIRECTIONS as Record<string, { palettes: readonly PaletteFamily[] }>
  )[direction];
  if (!known || known.palettes.length === 0) return true;
  return known.palettes.some(
    (family) => paletteFamilyIssues(family, page).length === 0,
  );
}

/** A colour a page could be painted, in the words a merchant uses. */
const PAGE_COLOUR =
  "(?:\\b(?:white|off[ -]?white|ivory|cream(?:y)?|eggshell|bone|beige|sand|linen|light|pale|bright|black|dark|charcoal|gr[ae]y|silver|navy|blue|green|sage|olive|mint|teal|turquoise|red|pink|rose|blush|peach|coral|orange|terracotta|rust|brown|tan|khaki|yellow|mustard|gold(?:en)?|purple|violet|lilac|lavender|plum|maroon|burgundy|neutral|pastel|colou?red|colou?rful|plain|warm|cool)\\b|#[0-9a-f]{3,8}\\b)";
/** The page itself, as a merchant names it. */
const PAGE_NOUN =
  "\\b(?:backgrounds?|backdrops?|pages?|canvas|base colou?r|page colou?r)\\b";
/**
 * A page colour named with the page: "a pure white background", "white or
 * ivory pages", "the background in white", "page colour: cream".
 */
const NAMED_PAGE_COLOUR: readonly RegExp[] = [
  new RegExp(
    `${PAGE_COLOUR}(?:[\\s,/-]+[\\w'-]+){0,2}?[\\s,/-]+${PAGE_NOUN}`,
    "i",
  ),
  new RegExp(
    `${PAGE_NOUN}(?:[\\s:,-]+[\\w'-]+){0,3}?[\\s:,-]+${PAGE_COLOUR}`,
    "i",
  ),
];
/**
 * A page-like colour on its own, read only where the merchant describes the
 * look (the brief's look and what to avoid, a refinement's instruction):
 * "leafy green and off-white", "light and modern", "dark and quiet". Never
 * "white space", and never in the facts, where "white bread" is a product.
 */
const LOOK_PAGE_COLOUR =
  /\b(?:white(?![ -]?space)|off[ -]?white|ivory|cream(?:y)?|eggshell|beige|linen|light(?![ -]?(?:hearted|weight))|pale|black|dark|charcoal|gr[ae]y)\b/i;

/**
 * ★★ THE MERCHANT NAMED THE PAGE COLOUR (review fix, 25 Oct): their words
 * (the brief, or a refinement's instruction) name a page or background
 * colour, so palette honesty never moves the page the answer painted
 * (`fitRevampPageToDirection`). Generous on purpose: a false match only
 * leaves the answer's page as it wrote it.
 */
export function revampMerchantNamesPage(request: RevampRequest): boolean {
  const brief = (request.brief ?? {}) as Partial<RevampRequest["brief"]>;
  // ★ Each part on its own: a page noun ending one field never pairs with a
  //   colour word opening the next ("background" + "warm and earthy").
  const strings = (parts: unknown[]) =>
    parts.filter((part): part is string => typeof part === "string");
  const lookParts = strings([brief.look, brief.avoid, request.instruction]);
  const allParts = strings([
    brief.business,
    brief.audience,
    ...(Array.isArray(brief.facts) ? brief.facts : []),
    ...lookParts,
  ]);
  return (
    allParts.some((part) =>
      NAMED_PAGE_COLOUR.some((pattern) => pattern.test(part)),
    ) || lookParts.some((part) => LOOK_PAGE_COLOUR.test(part))
  );
}

/** How far a page colour moves toward the accent at each try (percent). */
const PAGE_FIT_STEP = 5;
/** The furthest a page colour moves toward the accent to fit its direction. */
const PAGE_FIT_MAX = 60;

/**
 * ★★ PALETTE HONESTY (v5; robustness audit, section 5, step 3). Every plan of
 * the audit chose soft-and-natural, whose page is "visibly sage, clay or
 * mineral", and every one painted a near-white page: the direction was a
 * label. A page colour that no palette of the chosen direction accepts is
 * mended, and only it (B18's rule): moved toward the store's own accent, the
 * least that fits, never across light and dark, with the rest of the palette
 * kept and the contrast rules unrelaxed (text the move leaves unreadable is
 * mended by `repairRevampPalette`, which keeps the moved page or the result
 * is refused). When no move fits and reads, the page colour is dropped for
 * the theme's own, if that one fits; otherwise the palette is kept as it was.
 * ★ Silent, and never a repair call: the owner's step costs no model call.
 * ★★ ONLY A PAGE COLOUR MINK CHOSE (review fix, 25 Oct). `buildDesign` never
 *   calls it for a refinement, or when the merchant's words name a page
 *   colour (`revampMerchantNamesPage`): their page stays as the answer
 *   painted it, under the direction the answer chose, whose label only
 *   steers the photographs' mood, the redo memory and the distinctness
 *   check's preferences ("clean, on a pure white background, with soft
 *   natural touches" is a white page in a soft and natural style).
 */
export function fitRevampPageToDirection(
  palette: Partial<Record<DesignPaletteToken, string>>,
  fallback: Partial<Record<DesignPaletteToken, string>>,
  direction: string,
  usedSchemes: ReadonlySet<SectionScheme>,
): {
  palette: Partial<Record<DesignPaletteToken, string>>;
  outcome: "fits" | "moved" | "theme" | "kept";
} {
  const page = palette.cream ?? fallback.cream;
  if (!page || revampPageFitsDirection(direction, page)) {
    return { palette, outcome: "fits" };
  }
  const passes = (candidate: Partial<Record<DesignPaletteToken, string>>) =>
    paletteProblems({ ...fallback, ...candidate }, fallback, usedSchemes)
      .length === 0;
  const fits = (candidate: Partial<Record<DesignPaletteToken, string>>) => {
    const cream = candidate.cream ?? fallback.cream;
    return !!cream && revampPageFitsDirection(direction, cream);
  };
  const accent = palette.accent ?? fallback.accent;
  const light = isLightColour(page);
  if (accent) {
    for (
      let weight = PAGE_FIT_STEP;
      weight <= PAGE_FIT_MAX;
      weight += PAGE_FIT_STEP
    ) {
      const cream = mixHex(accent, page, weight);
      // ★ Never across light and dark (paletteProblems would refuse such a
      //   page as well; this stops the search there).
      if (isLightColour(cream) !== light) break;
      if (!revampPageFitsDirection(direction, cream)) continue;
      const moved = { ...palette, cream };
      if (passes(moved)) return { palette: moved, outcome: "moved" };
      const mended = repairRevampPalette(moved, fallback, usedSchemes);
      if (mended.outcome === "repaired" && fits(mended.palette)) {
        return { palette: mended.palette, outcome: "moved" };
      }
    }
  }
  if (palette.cream !== undefined && fallback.cream && fits({})) {
    const rest = { ...palette };
    delete rest.cream;
    if (passes(rest)) return { palette: rest, outcome: "theme" };
  }
  return { palette, outcome: "kept" };
}

/** The most notes a plan carries to the card (fixes first, then the model's). */
const MAX_NOTES = 5;
/** Issues past this many are summarised: a repair needs the shape, not 200 lines. */
const MAX_ISSUES = 80;
/** Two frames this close in shape are one frame (the binding rule). */
const SAME_SHAPE_TOLERANCE = 0.03;
/** A frame wider than this takes a phone crop when it is an opening photo. */
const WIDE_ASPECT = 1.2;

const SHOT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHOT_ID_MAX = 40;
/** A shot id the photos step reserves. */
const RESERVED_SHOT_IDS = new Set(["anchor"]);

/** Text fields of a section config that shoppers read. */
const COPY_KEYS = new Set([
  "heading",
  "subheading",
  "body",
  "eyebrow",
  "cta_label",
  "badge_text",
  "subtext",
  "title",
  "subtitle",
  "caption",
  "image_alt",
  "question",
  "answer",
  "button_label",
  "success_message",
  "consent_text",
  "label",
  "category",
]);

/** List-of-string fields whose items shoppers read (the ticker's lines). */
const COPY_LIST_KEYS = new Set(["messages"]);

/** Tags a revamp's rich text may hold, with no attributes except a link's. */
const RICH_TEXT_TAGS = new Set([
  "p",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "strong",
  "b",
  "em",
  "i",
  "br",
  "a",
]);

/** Product sections: only with real products behind them. */
const PRODUCT_SECTION_TYPES = new Set([
  "featured_products",
  "product_spotlight",
]);

type Path = Array<string | number>;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Cut at a word boundary under `max` characters; trims the end. */
export function clipText(value: string, max: number): string {
  const s = value.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut)
    .replace(/[\s,;:.-]+$/, "")
    .trim();
}

/** 32-bit FNV-1a, base 36: short, stable ids from a key. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function formatPath(path: Path): string {
  let out = "";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : out ? `.${part}` : part;
  }
  return out;
}

/** The last named key on a path (an array index is skipped). */
function lastKey(path: Path): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const part = path[i];
    if (typeof part === "string") return part;
  }
  return "";
}

function getAt(root: unknown, path: Path): unknown {
  let node: unknown = root;
  for (const part of path) {
    if (Array.isArray(node) && typeof part === "number") node = node[part];
    else if (isRecord(node) && typeof part === "string") node = node[part];
    else return undefined;
  }
  return node;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  let node: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i];
    if (Array.isArray(node) && typeof part === "number") node = node[part];
    else if (isRecord(node) && typeof part === "string") node = node[part];
    else return;
  }
  const last = path[path.length - 1];
  if (Array.isArray(node) && typeof last === "number") node[last] = value;
  else if (isRecord(node) && typeof last === "string") node[last] = value;
}

/** Every string leaf with its path, depth first. */
function stringLeaves(
  node: unknown,
  path: Path = [],
  out: Array<{ value: string; path: Path }> = [],
): Array<{ value: string; path: Path }> {
  if (typeof node === "string") out.push({ value: node, path });
  else if (Array.isArray(node))
    node.forEach((item, i) => stringLeaves(item, [...path, i], out));
  else if (isRecord(node))
    for (const [key, value] of Object.entries(node))
      stringLeaves(value, [...path, key], out);
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

/** "#abc" → "#aabbcc", lowercase; null for anything that is not hex. */
export function normalizeRevampHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return null;
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
}

/** True for a colour dark text reads on (the page polarity rule). */
export function isLightColour(hex: string): boolean {
  return contrastRatio(hex, "#000000") >= contrastRatio(hex, "#ffffff");
}

/** The page's own label in issue sentences: the homepage is "home". */
function pageLabel(slug: string): string {
  return slug === "" ? REVAMP_HOME_SLUG : slug;
}

/** A model-written page slug, normalised: "home", "/" and "" are the homepage. */
export function normalizeRevampPageSlug(value: unknown): string {
  const s = text(value)
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "");
  return s === REVAMP_HOME_SLUG || s === "index" ? "" : s;
}

// ---------------------------------------------------------------------------
// Product and category slugs: what will exist after Apply.
// ---------------------------------------------------------------------------

/**
 * The web address a new product gets: the name, accents folded, lowercase,
 * "&" as "and", everything else a hyphen, at most 80 characters; "-2", "-3"
 * on a collision with `taken`. ★ A2 assigns new products their slugs with
 * this, in request order, so the plan's `/shop/<slug>` links and the created
 * products agree by construction.
 */
export function revampProductSlug(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/g, "") || "product";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A product name as two products are compared by: folded, trimmed, one space, any case. */
function productNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The merchant's products the store already has, by request key: one of the
 * store's own products (never a theme sample) with the same name, case and
 * spacing aside. A published one is preferred when several share the name.
 * ★ NEVER CREATED AGAIN (known-1b): a second "Groundnut Oil" at
 *   /shop/groundnut-oil-2 beside the first is a duplicate the merchant then
 *   has to find and delete, and links meant for their product would reach
 *   the copy. A sample does not count: it is taken off the shop, and the
 *   merchant's product is what replaces it.
 */
export function revampExistingProducts(input: {
  request: Pick<RevampRequest, "products">;
  snapshot: Pick<RevampSnapshot, "products">;
}): Map<string, RevampSnapshotProduct> {
  const byName = new Map<string, RevampSnapshotProduct>();
  for (const product of input.snapshot.products) {
    if (product.sample || /\(sample\)\s*$/i.test(product.name)) continue;
    const name = productNameKey(product.name);
    if (!name) continue;
    const held = byName.get(name);
    if (
      !held ||
      (held.status !== "published" && product.status === "published")
    ) {
      byName.set(name, product);
    }
  }
  const out = new Map<string, RevampSnapshotProduct>();
  for (const product of input.request.products) {
    const existing = byName.get(productNameKey(product.name));
    if (existing) out.set(product.key, existing);
  }
  return out;
}

/** The request keys of products the store already has (see revampExistingProducts). */
export function revampExistingProductKeys(input: {
  request: Pick<RevampRequest, "products">;
  snapshot: Pick<RevampSnapshot, "products">;
}): Set<string> {
  return new Set(revampExistingProducts(input).keys());
}

/**
 * Each new product's slug, by key, in request order (the A2 rule). A
 * product the store already has gets none: it is not created.
 */
export function revampNewProductSlugs(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): Map<string, string> {
  const taken = new Set(input.snapshot.products.map((p) => p.slug));
  const existing = revampExistingProductKeys(input);
  const out = new Map<string, string>();
  for (const product of input.request.products) {
    if (existing.has(product.key)) continue;
    const slug = revampProductSlug(product.name, taken);
    taken.add(slug);
    out.set(product.key, slug);
  }
  return out;
}

/** The slug a confirmed category `create` makes, or "" when it gives none. */
function createdCategorySlug(change: {
  name: string;
  slug: string | null;
}): string {
  return (change.slug ?? "").trim() || categorySlugFromName(change.name);
}

/**
 * One confirmed category change as a key: what it does and to which
 * category ("create:seed-oils", "update:oils", "hide:fruits"). ★ The
 * category, never the words: a refinement carries its parent's changes
 * through the request reader again, which may tidy a description, and a key
 * that moved with it would charge the parent's change twice.
 */
export function revampCategoryChangeKey(
  change: RevampRequest["categories"][number],
): string {
  if (change.action !== "create") return `${change.action}:${change.slug}`;
  return `create:${createdCategorySlug(change) || productNameKey(change.name)}`;
}

/**
 * How many of `changes` the parent already made: each matched once against
 * the parent's keys. ★ By key, never by position: a refinement of an applied
 * parent carries none of the parent's changes (they are on the store), so
 * its changes are all its own however many the parent had.
 */
function carriedCategoryCount(
  changes: RevampRequest["categories"],
  parentKeys: readonly string[] | undefined,
): number {
  if (!parentKeys) return 0;
  const left = new Map<string, number>();
  for (const key of parentKeys) left.set(key, (left.get(key) ?? 0) + 1);
  let carried = 0;
  for (const change of changes) {
    const key = revampCategoryChangeKey(change);
    const n = left.get(key) ?? 0;
    if (n === 0) continue;
    left.set(key, n - 1);
    carried += 1;
  }
  return carried;
}

/**
 * Categories that will exist after Apply: every active category, less the
 * ones the merchant agreed to hide, plus the ones they agreed to create.
 * (Theme sample categories are included: they exist; see `revampLinkTargets`
 * for what a link may point at.)
 */
export function revampCategorySlugs(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): Set<string> {
  const out = new Set(
    input.snapshot.categories
      .filter((c) => c.status === "active")
      .map((c) => c.slug),
  );
  for (const change of input.request.categories) {
    if (change.action === "hide") out.delete(change.slug);
    else if (change.action === "create") {
      const slug = createdCategorySlug(change);
      if (slug) out.add(slug);
    }
  }
  return out;
}

/** Categories after Apply that are not theme samples. */
function realCategorySlugs(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): Set<string> {
  const sample = new Set(
    input.snapshot.categories.filter((c) => c.sample).map((c) => c.slug),
  );
  const all = revampCategorySlugs(input);
  return new Set([...all].filter((slug) => !sample.has(slug)));
}

/** Published products that are not theme samples, in the snapshot's order. */
function realPublishedProducts(
  snapshot: RevampSnapshot,
): RevampSnapshotProduct[] {
  return snapshot.products.filter(
    (p) =>
      p.status === "published" && !p.sample && !/\(sample\)\s*$/i.test(p.name),
  );
}

/** Published products that are not theme samples, by slug. */
function realProductSlugs(snapshot: RevampSnapshot): string[] {
  return realPublishedProducts(snapshot).map((p) => p.slug);
}

/** Where a featured_products band finds its products once applied. */
export type RevampFeaturedBinding =
  | { source: "featured" }
  | { source: "manual"; productIds: string[] };

/**
 * How a featured_products band shows products after Apply: "featured" when
 * the redesign creates a product (Apply writes each new one featured) or one
 * of the store's own published products is featured already; otherwise the
 * store's own published products by id, in the snapshot's order (most
 * recently changed first), up to the band's limit. Null when there is no
 * real product to show at all.
 * ★★ "featured" READS products.featured, WHICH DEFAULTS TO FALSE (output-5).
 *    On a store whose own products were never featured (the theme's samples,
 *    which Apply hides, were the featured ones) a "featured" band publishes
 *    with nothing in it and draws nothing, so the homepage loses the product
 *    band the merchant approved. Naming the products shows them whatever the
 *    flag says, in the preview and once live.
 * ★ A theme sample never counts and is never named, featured or not, and a
 *   product the snapshot carries no flag for counts as not featured: naming
 *   it can only show a real product, where guessing "featured" can show none.
 */
export function revampFeaturedBinding(
  snapshot: RevampSnapshot,
  options: { createsProducts: boolean; limit: number },
): RevampFeaturedBinding | null {
  if (options.createsProducts) return { source: "featured" };
  const real = realPublishedProducts(snapshot);
  if (real.some((p) => p.featured === true)) return { source: "featured" };
  if (real.length === 0) return null;
  return {
    source: "manual",
    productIds: real.slice(0, clampLimit(options.limit)).map((p) => p.id),
  };
}

/**
 * True when product sections will have real products to show: a product the
 * revamp creates, or one of the store's own published products. (A request
 * product the store already has is one of those, or a draft, which no
 * product section shows.)
 */
export function revampHasRealProducts(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): boolean {
  return (
    revampNewProductSlugs(input).size > 0 ||
    realProductSlugs(input.snapshot).length > 0
  );
}

/**
 * True when a "shop by category" band will show only real categories: at
 * least two that are not theme samples, and no sample category left active
 * (a band of "all categories" would show the theme's "Shirts" on an oil
 * shop).
 */
export function revampCategoryBandAllowed(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): boolean {
  const all = revampCategorySlugs(input);
  const real = realCategorySlugs(input);
  return real.size >= 2 && real.size === all.size;
}

/**
 * What a link may point at after Apply. pages: the plan's pages and every
 * published page (policy pages included); categories: real categories after
 * the confirmed changes; products: real published products and the new ones.
 */
export function revampLinkTargets(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
  plan: Pick<RevampSitePlan, "pages">;
}): { pages: Set<string>; categories: Set<string>; products: Set<string> } {
  const pages = new Set<string>();
  for (const page of input.snapshot.pages) {
    if (page.slug && page.status === "published") pages.add(page.slug);
  }
  for (const page of input.plan.pages) {
    if (page.slug) pages.add(page.slug);
  }
  const products = new Set(realProductSlugs(input.snapshot));
  for (const slug of revampNewProductSlugs(input).values()) products.add(slug);
  return { pages, categories: realCategorySlugs(input), products };
}

/**
 * The storefront's own pages a link may name like a store page: the blog
 * and the enquiry form, which every store serves (app/(storefront)/(pages)
 * /blogs and /enquiries) whatever a redesign changes. Their slugs are
 * reserved, so no store page can take them.
 * ★★ WITHOUT THEM A REDESIGN DROPPED WORKING LINKS (output-6). The default
 *    header links Blogs and Enquiries and the default footer links Blog; a
 *    model that kept them got a false "will not exist after Apply" repair
 *    and the links were dropped, and the checks took them out of a footer
 *    the plan never wrote. A post (/blogs/<slug>) is not one of these: the
 *    snapshot does not read posts, so a model cannot be shown which exist.
 */
export const REVAMP_STOREFRONT_ROUTES: readonly string[] = [
  "/blogs",
  "/enquiries",
];

/**
 * The first path segments of the storefront routes every store serves
 * whatever a redesign changes: the blog and its posts, the enquiry form,
 * and the shopper's cart, orders, profile and notifications. Not the shop
 * and collection pages, whose products and categories a redesign can hide.
 */
const ALWAYS_SERVED_SEGMENTS: ReadonlySet<string> = new Set([
  "blogs",
  "enquiries",
  "cart",
  "orders",
  "profile",
  "notifications",
]);

/**
 * True when a site path names a storefront route every store serves, so a
 * link the merchant already has to it keeps working after Apply (a post the
 * store links in its own footer, "/blogs/first-harvest", included). For the
 * checks, which leave such a link alone; a link the model writes still has
 * to pass checkRevampLink.
 */
export function revampAlwaysServedLink(value: string): boolean {
  const raw = value.trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return false;
  const path = raw.toLowerCase().split(/[?#]/)[0];
  const first = path.slice(1).split("/")[0] ?? "";
  return ALWAYS_SERVED_SEGMENTS.has(first);
}

/**
 * A link, normalised, when it reaches something that will exist; null when
 * it does not. "" stays "" (no link). Allowed: "/", "/shop",
 * "/collections/<category>", "/shop/<product>", "/<page>", and the
 * storefront's own "/blogs" and "/enquiries" (REVAMP_STOREFRONT_ROUTES).
 */
export function checkRevampLink(
  value: string,
  targets: {
    pages: Set<string>;
    categories: Set<string>;
    products: Set<string>;
  },
): string | null {
  const raw = value.trim();
  if (!raw) return "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[?#]/.test(raw)) return null;
  const path = raw.toLowerCase().replace(/\/+$/, "") || "/";
  if (path === "/") return "/";
  if (path === "/shop") return "/shop";
  if (REVAMP_STOREFRONT_ROUTES.includes(path)) return path;
  const parts = path.slice(1).split("/");
  if (parts.length === 2 && parts[0] === "collections") {
    return targets.categories.has(parts[1]) ? path : null;
  }
  if (parts.length === 2 && parts[0] === "shop") {
    return targets.products.has(parts[1]) ? path : null;
  }
  if (parts.length === 1 && targets.pages.has(parts[0])) return path;
  return null;
}

// ---------------------------------------------------------------------------
// Scope: which pages the plan writes.
// ---------------------------------------------------------------------------

export interface RevampScopePage {
  /** "" for the homepage. */
  slug: string;
  /** The store's page, or null when the plan creates it. */
  snapshotPage: RevampSnapshotPage | null;
  /** False when a refinement copies the page from the previous plan. */
  write: boolean;
}

export interface RevampPageScope {
  /** In order: the homepage first. */
  pages: RevampScopePage[];
  /** How many pages the model may add beyond `pages`. */
  newPagesAllowed: number;
  /** True when the merchant named the pages (only those are written). */
  named: boolean;
  /** Pages the plan cannot write, in the merchant's words. */
  skipped: Array<{ label: string; reason: string }>;
}

function pageTitleLabel(page: RevampSnapshotPage): string {
  return page.slug === ""
    ? "Home page"
    : `The "${page.title || page.slug}" page`;
}

/**
 * The pages a revamp writes (build spec section 4). Default: the homepage,
 * then every readable page that is not a policy page (published first), at
 * most `REVAMP_LIMITS.maxPages` in all, with room left for new pages the
 * business needs. Named: only the pages the merchant named (a name that is
 * not a page yet becomes a new page). A refinement: the previous plan's
 * pages, written again only where `refineScope.pages` allows.
 */
export function revampPageScope(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
  previous?: RevampSitePlan | null;
}): RevampPageScope {
  const { request, snapshot } = input;
  const previous = request.kind === "refine" ? (input.previous ?? null) : null;
  const max = REVAMP_LIMITS.maxPages;
  const bySlug = new Map(snapshot.pages.map((p) => [p.slug, p]));
  const skipped: Array<{ label: string; reason: string }> = [];
  const pages: RevampScopePage[] = [];
  const seen = new Set<string>();

  /** A slug a new page may take: a valid address no page uses. */
  const newSlugOk = (slug: string): boolean =>
    !!slug &&
    !REVAMP_SKIPPED_SLUGS.has(slug) &&
    "slug" in validatePageSlug(slug);

  /** Why a page cannot be written, in the merchant's words; null when it can. */
  const refusal = (
    slug: string,
    page: RevampSnapshotPage | null,
  ): string | null => {
    // ★ Policy first, whatever else is true of the page: the four policy
    //   addresses are never written, whether or not the store has them yet.
    if (REVAMP_SKIPPED_SLUGS.has(slug) || page?.skipped === "policy") {
      return "Policy pages are never changed by a redesign.";
    }
    if (page?.skipped === "invalid") {
      return "It could not be read, so it was left as it is.";
    }
    if (!page && slug !== "" && !newSlugOk(slug)) {
      return "That page address cannot be used for a page.";
    }
    return null;
  };
  const labelOf = (slug: string, page: RevampSnapshotPage | null): string =>
    page ? pageTitleLabel(page) : `The "${slug || REVAMP_HOME_SLUG}" page`;

  const add = (slug: string, write: boolean): boolean => {
    if (seen.has(slug)) return false;
    seen.add(slug);
    const page = bySlug.get(slug) ?? null;
    const reason = refusal(slug, page);
    if (reason) {
      skipped.push({ label: labelOf(slug, page), reason });
      return false;
    }
    if (pages.length >= max) {
      skipped.push({
        label: labelOf(slug, page),
        reason: `A redesign writes at most ${max} pages at a time.`,
      });
      return false;
    }
    pages.push({ slug, snapshotPage: page, write });
    return true;
  };

  if (previous) {
    const scope = request.refineScope;
    const subset = scope?.pages
      ? new Set(scope.pages.map(normalizeRevampPageSlug))
      : null;
    const fixed = !!scope && !scope.copy && !scope.layout;
    for (const page of previous.pages) {
      add(page.slug, !fixed && (!subset || subset.has(page.slug)));
    }
    for (const slug of subset ?? []) add(slug, !fixed);
    const open = !fixed && !subset && (scope?.layout ?? true);
    return {
      pages,
      newPagesAllowed: open ? Math.max(0, max - pages.length) : 0,
      named: !!subset,
      skipped,
    };
  }

  if (request.pages !== null) {
    const named = request.pages.map(normalizeRevampPageSlug);
    // The homepage first when it is named, then the merchant's order.
    if (named.includes("")) add("", true);
    for (const slug of named) add(slug, true);
    return { pages, newPagesAllowed: 0, named: true, skipped };
  }

  add("", true);
  const others = snapshot.pages
    .filter((p) => p.slug !== "")
    .sort((a, b) => {
      const rank = (p: RevampSnapshotPage) =>
        p.status === "published" ? 0 : 1;
      return rank(a) - rank(b);
    });
  for (const page of others) {
    // ★ A policy page is never in a default scope, so it is not "left
    //   out" either: listing four of them on every card is noise. An
    //   unreadable page is worth saying (add() says it).
    if (page.skipped === "policy" || REVAMP_SKIPPED_SLUGS.has(page.slug)) {
      seen.add(page.slug);
      continue;
    }
    add(page.slug, true);
  }
  return {
    pages,
    newPagesAllowed: Math.max(0, max - pages.length),
    named: false,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Photos: which the store owns, which a revamp replaces, which frame a field
// ends at.
// ---------------------------------------------------------------------------

/** Image fields a section holds (keys ending _url), video aside. */
function isImageKey(key: string): boolean {
  return key.endsWith("_url") && key !== "video_url";
}

function sectionImageLeaves(
  section: PageSectionItem,
): Array<{ value: string; path: Path }> {
  return stringLeaves(section.config).filter(
    (leaf) => isImageKey(lastKey(leaf.path)) && leaf.value.trim() !== "",
  );
}

/** Photos a revamp must replace wherever they are left (theme, Mink, broken). */
function replaceableSet(snapshot: RevampSnapshot): Set<string> {
  return new Set([
    ...snapshot.photos.replaceable.map((u) => u.trim()),
    ...snapshot.photos.broken.map((u) => u.trim()),
  ]);
}

function isReplaceable(url: string, replaceable: ReadonlySet<string>): boolean {
  const value = url.trim();
  if (!value || value.startsWith(REVAMP_SLOT_PREFIX)) return false;
  return replaceable.has(value) || isThemePhotoUrl(value);
}

/**
 * Photos a new section may use as they are: the merchant's product photos,
 * real products' and categories' photos, and the photos in the merchant's
 * own sections, less anything a revamp replaces (a theme file, an earlier
 * Mink photo, a broken link).
 */
export function revampOwnedPhotoUrls(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): Set<string> {
  const { request, snapshot } = input;
  const replaceable = replaceableSet(snapshot);
  const out = new Set<string>();
  const offer = (url: string | null | undefined, fromSection: boolean) => {
    const value = (url ?? "").trim();
    if (!value || isReplaceable(value, replaceable)) return;
    if (value.startsWith(REVAMP_SLOT_PREFIX)) return;
    // ★ A section's earlier Mink campaign picture is replaced, never reused;
    //   a product's own catalogue photo is the product's.
    if (fromSection && isMinkAiMadePhotoUrl(value)) return;
    out.add(value);
  };
  for (const product of request.products) offer(product.photoUrl, false);
  for (const product of snapshot.products) {
    if (product.status === "published" && !product.sample) {
      offer(product.imageUrl, false);
    }
  }
  for (const category of snapshot.categories) {
    if (!category.sample) offer(category.imageUrl, false);
  }
  for (const page of snapshot.pages) {
    for (const section of page.sections) {
      if (page.owners[section.id] !== "merchant") continue;
      for (const leaf of sectionImageLeaves(section)) offer(leaf.value, true);
    }
  }
  return out;
}

/** One of the merchant's real products a shot may show (B16). */
export interface RevampGoodsItem {
  /** The key a shot names it by: a request key ("p1") or "shop:<slug>". */
  key: string;
  name: string;
  /** The product's own photo: the reference the photos step draws from. */
  photoUrl: string;
  /** The category it is filed under after Apply, or null. */
  categorySlug: string | null;
}

/** The goods key of a product the store already sells. */
export function revampGoodsKeyForSlug(slug: string): string {
  return `shop:${slug}`;
}

/**
 * True when a photo URL's object lives under ANOTHER store's prefix
 * (`…/stores/<id>/…`). ★ The same question `isOtherStoreObjectPath` asks
 * (lib/storage/paths.ts), asked of a URL here because this module is pure
 * and reads no bucket name: a legacy path outside `stores/` is not provably
 * anybody else's and passes.
 */
function isOtherStorePhoto(url: string, storeId: string): boolean {
  const owner = storeFolderOf(url);
  return owner !== null && owner !== storeId;
}

/** The store whose folder (`…/stores/<id>/…`) a photo URL names, or null. */
function storeFolderOf(url: string): string | null {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // A site path, read as it is.
  }
  return /(?:^|\/)stores\/([^/]+)\//.exec(path)?.[1] ?? null;
}

/**
 * ★★ Whether the photos step can read a product photo as a reference (B16):
 * it reads only objects under this store's own prefix in our bucket
 * (`readStoreOwnedImageBytes`), so a photo it can never read is no photo
 * here, and the planner is never told photo=yes for it (a catalogue imported
 * with outside links would otherwise have every shot of its goods drawn with
 * no product photo at all). The snapshot lists them by the bucket's own rule
 * (`photos.readable`); one read before that list was carried takes a photo
 * whose address names this store's own folder.
 */
function goodsPhotoReader(snapshot: RevampSnapshot): (url: string) => boolean {
  const listed = snapshot.photos?.readable;
  if (Array.isArray(listed)) {
    const readable = new Set(listed);
    return (url) => readable.has(url);
  }
  return (url) => storeFolderOf(url) === snapshot.storeId;
}

/**
 * ★★ REAL GOODS OR NO GOODS (B16). The products a redesign's banner,
 * content or category photograph may show, by goods key: each of the
 * merchant's own products that has its own photo, the store's or the one
 * attached in the chat. A request product keeps its key ("p1"); a product
 * the store already sells is "shop:<slug>". The photo must be one the store
 * owns (`revampOwnedPhotoUrls`: never a theme file, an earlier Mink photo or
 * a broken link), never one under another store's prefix, so a key can
 * never cross stores, and one the photos step can read (`goodsPhotoReader`).
 * A product with no such photo is not here: a shot cannot show what it has
 * no photo of without inventing it.
 * ★ The compiler validates a shot's keys with this, and the photos step
 *   resolves a validated key to its photo with this, so the two agree.
 */
export function revampGoodsCatalogue(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): Map<string, RevampGoodsItem> {
  const { request, snapshot } = input;
  const owned = revampOwnedPhotoUrls(input);
  const readable = goodsPhotoReader(snapshot);
  const usable = (url: string | null | undefined): string | null => {
    const value = (url ?? "").trim();
    if (!value || !owned.has(value)) return null;
    if (isOtherStorePhoto(value, snapshot.storeId)) return null;
    return readable(value) ? value : null;
  };
  const categoryById = new Map(snapshot.categories.map((c) => [c.id, c.slug]));
  const existing = revampExistingProducts(input);
  const out = new Map<string, RevampGoodsItem>();
  const shown = new Set<string>();
  for (const product of request.products) {
    const match = existing.get(product.key);
    const photo = usable(product.photoUrl) ?? usable(match?.imageUrl);
    if (!photo) continue;
    // ★ The merchant's product the store already sells is one product: its
    //   request key stands for it, never a second "shop:" key beside it.
    if (match) shown.add(match.id);
    out.set(product.key, {
      key: product.key,
      name: product.name,
      photoUrl: photo,
      categorySlug:
        product.categorySlug ??
        (match?.categoryId
          ? (categoryById.get(match.categoryId) ?? null)
          : null),
    });
  }
  for (const product of realPublishedProducts(snapshot)) {
    if (shown.has(product.id)) continue;
    const photo = usable(product.imageUrl);
    if (!photo) continue;
    const key = revampGoodsKeyForSlug(product.slug);
    if (out.has(key)) continue;
    out.set(key, {
      key,
      name: product.name,
      photoUrl: photo,
      categorySlug: product.categoryId
        ? (categoryById.get(product.categoryId) ?? null)
        : null,
    });
  }
  return out;
}

/**
 * Every way a model might name a goods key, to the key: the key in any case,
 * the product's /shop/ address, its bare slug, or its name.
 */
function goodsAliases(
  input: { request: RevampRequest; snapshot: RevampSnapshot },
  catalogue: ReadonlyMap<string, RevampGoodsItem>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const add = (alias: string, key: string) => {
    const a = alias.trim().toLowerCase();
    if (a && !aliases.has(a)) aliases.set(a, key);
  };
  for (const item of catalogue.values()) add(item.key, item.key);
  const newSlugs = revampNewProductSlugs(input);
  const existing = revampExistingProducts(input);
  for (const product of input.request.products) {
    if (!catalogue.has(product.key)) continue;
    const slug = newSlugs.get(product.key) ?? existing.get(product.key)?.slug;
    if (slug) {
      add(revampGoodsKeyForSlug(slug), product.key);
      add(`/shop/${slug}`, product.key);
      add(slug, product.key);
    }
  }
  for (const item of catalogue.values()) {
    if (item.key.startsWith("shop:")) {
      const slug = item.key.slice("shop:".length);
      add(`/shop/${slug}`, item.key);
      add(slug, item.key);
    }
  }
  for (const item of catalogue.values())
    add(productNameKey(item.name), item.key);
  return aliases;
}

type FrameKey = keyof typeof IMAGE_SPECS;

function ratioWord(value: unknown): "portrait" | "square" | "landscape" {
  return value === "square" || value === "landscape" ? value : "portrait";
}

/**
 * The IMAGE_SPECS frame a section's image field ends at (the builder's own
 * choice for that field, `app/dashboard/builder/section-form.tsx`, and the
 * product spec's section 8), or null when the field takes no photograph.
 */
export function revampFrameKeyFor(
  type: string,
  config: unknown,
  path: Path,
): FrameKey | null {
  const c = isRecord(config) ? config : {};
  const key = lastKey(path);
  const top = path.length === 1;
  const item =
    path.length === 3 &&
    typeof path[0] === "string" &&
    typeof path[1] === "number"
      ? path[0]
      : null;
  switch (type) {
    case "hero":
      if (top && key === "image_url") {
        return c.variant === "banner" || c.variant === "split"
          ? "hero_side"
          : "hero_wide";
      }
      return top && key === "mobile_image_url" ? "hero_phone" : null;
    case "hero_carousel":
      if (item !== "slides") return null;
      if (key === "image_url")
        return c.layout === "split" ? "hero_side" : "hero_wide";
      return key === "mobile_image_url" ? "hero_phone" : null;
    case "promo_banner":
      return top && key === "image_url" ? "hero_wide" : null;
    case "tile_grid":
      return item === "tiles" && key === "image_url" ? "landscape" : null;
    case "media_text":
      return (top || item === "stories") && key === "image_url"
        ? specForRatio(ratioWord(c.media_ratio))
        : null;
    case "gallery":
      if (item !== "items" || key !== "image_url") return null;
      return c.layout === "grid"
        ? specForRatio(ratioWord(c.image_ratio))
        : "landscape";
    case "multicolumn":
    case "image_marquee":
      return item === "items" && key === "image_url"
        ? specForRatio(ratioWord(c.image_ratio))
        : null;
    case "accordion":
      return item === "items" && key === "image_url" ? "landscape" : null;
    case "image_hotspots":
      return top && key === "image_url"
        ? specForRatio(ratioWord(c.image_ratio))
        : null;
    case "before_after":
      return path.length === 2 &&
        (path[0] === "before" || path[0] === "after") &&
        key === "image_url"
        ? specForRatio(ratioWord(c.image_ratio))
        : null;
    case "video":
      if (!top || key !== "poster_url") return null;
      return c.aspect_ratio === "square"
        ? "square"
        : c.aspect_ratio === "portrait"
          ? "portrait"
          : "video_poster";
    default:
      return null;
  }
}

function frameOf(key: FrameKey): RevampSlotBinding["frame"] {
  const spec = IMAGE_SPECS[key];
  return {
    width: spec.width,
    height: spec.height,
    aspect: spec.width / spec.height,
  };
}

/** The category photograph frame (build spec section 4). */
export const REVAMP_CATEGORY_FRAME: RevampSlotBinding["frame"] = {
  width: 1200,
  height: 1200,
  aspect: 1,
};

function sameShape(a: number, b: number): boolean {
  return Math.abs(a / b - 1) <= SAME_SHAPE_TOLERANCE;
}

/** The image model's ratio nearest a frame's shape. */
export function revampRatioFor(aspect: number): string {
  let best: string = THEME_IMAGE_ASPECT_RATIOS[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const ratio of THEME_IMAGE_ASPECT_RATIOS) {
    const gap = Math.abs(Math.log(aspectValue(ratio) / aspect));
    if (gap < bestGap) {
      best = ratio;
      bestGap = gap;
    }
  }
  return best;
}

/** The sibling phone field of a wide hero or slide image, or null. */
function phonePathFor(type: string, path: Path, aspect: number): Path | null {
  if (aspect <= WIDE_ASPECT) return null;
  if (type === "hero" && path.length === 1 && path[0] === "image_url") {
    return ["mobile_image_url"];
  }
  if (
    type === "hero_carousel" &&
    path.length === 3 &&
    path[0] === "slides" &&
    typeof path[1] === "number" &&
    path[2] === "image_url"
  ) {
    return ["slides", path[1], "mobile_image_url"];
  }
  return null;
}

/** The deterministic shot id that refills one field of a merchant section. */
export function revampRefillShotId(
  pageSlug: string,
  sectionId: string,
  path: Path,
): string {
  return `refill-${fnv1a(`${pageSlug}|${sectionId}|${formatPath(path)}`)}`;
}

/** The deterministic shot id of a category's photograph. */
export function revampCategoryShotId(slug: string): string {
  const plain = `category-${slug}`;
  const id = sanitizeShotId(plain);
  if (id === plain) return id;
  // ★ A long slug would be cut at the id limit, and two categories sharing a
  //   long prefix would then share one photograph: the slug's hash keeps them
  //   apart.
  return (
    sanitizeShotId(`category-${slug.slice(0, 20)}-${fnv1a(slug)}`) ??
    `category-${fnv1a(slug)}`
  );
}

export interface RevampRefillSlot {
  shotId: string;
  pageSlug: string;
  sectionId: string;
  sectionType: string;
  path: Path;
  frame: RevampSlotBinding["frame"];
  ratio: string;
  /** What the section says, to describe the picture by. */
  context: string;
}

/** The words a section offers to describe its picture by. */
function sectionContext(section: PageSectionItem, path: Path): string {
  const c = section.config as unknown;
  const near = [
    getAt(c, [...path.slice(0, -1), "image_alt"]),
    getAt(c, [...path.slice(0, -1), "heading"]),
    getAt(c, [...path.slice(0, -1), "title"]),
    getAt(c, [...path.slice(0, -1), "caption"]),
    getAt(c, ["heading"]),
    getAt(c, ["image_alt"]),
  ];
  for (const value of near) {
    const s = text(value).trim();
    if (s) return clipText(s, 160);
  }
  return section.type.replace(/_/g, " ");
}

/**
 * Photos inside the merchant's own sections on in-scope pages that a revamp
 * must replace: each gets a refill shot with a deterministic id, so the
 * prompt, the compiler and the fake plan name the same shot.
 */
export function revampRefillSlots(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
  previous?: RevampSitePlan | null;
}): RevampRefillSlot[] {
  const replaceable = replaceableSet(input.snapshot);
  const scope = revampPageScope(input);
  const out: RevampRefillSlot[] = [];
  for (const scopePage of scope.pages) {
    const page = scopePage.snapshotPage;
    if (!page) continue;
    for (const section of page.sections) {
      if (page.owners[section.id] !== "merchant") continue;
      out.push(...refillsOf(page.slug, section, replaceable));
    }
  }
  return out;
}

function refillsOf(
  pageSlug: string,
  section: PageSectionItem,
  replaceable: ReadonlySet<string>,
): RevampRefillSlot[] {
  const out: RevampRefillSlot[] = [];
  const refilledMains = new Set<string>();
  for (const leaf of sectionImageLeaves(section)) {
    if (!isReplaceable(leaf.value, replaceable)) continue;
    const key = lastKey(leaf.path);
    const frameKey = revampFrameKeyFor(section.type, section.config, leaf.path);
    if (!frameKey) continue;
    // A wide main photo takes the phone crop; its phone field is not a slot.
    if (key === "mobile_image_url") {
      const main = [...leaf.path.slice(0, -1), "image_url"];
      if (refilledMains.has(formatPath(main))) continue;
      const mainValue = text(getAt(section.config, main));
      if (isReplaceable(mainValue, replaceable) || !mainValue.trim()) continue;
    }
    if (key === "image_url") refilledMains.add(formatPath(leaf.path));
    const frame = frameOf(frameKey);
    out.push({
      shotId: revampRefillShotId(pageSlug, section.id, leaf.path),
      pageSlug,
      sectionId: section.id,
      sectionType: section.type,
      path: leaf.path,
      frame,
      ratio: revampRatioFor(frame.aspect),
      context: sectionContext(section, leaf.path),
    });
  }
  return out;
}

export interface RevampCategoryPhotoNeed {
  slug: string;
  name: string;
  action: "create" | "update";
}

/**
 * Categories that get a new photograph: a confirmed create, or an update the
 * merchant agreed should get a new photo (v1's rule).
 */
export function revampCategoryPhotoNeeds(input: {
  request: RevampRequest;
  snapshot: RevampSnapshot;
}): RevampCategoryPhotoNeed[] {
  const bySlug = new Map(input.snapshot.categories.map((c) => [c.slug, c]));
  const out: RevampCategoryPhotoNeed[] = [];
  const seen = new Set<string>();
  for (const change of input.request.categories) {
    // ★ A created category has no photograph, so it always gets one; an
    //   update gets one only when the merchant agreed to a new photo.
    if (change.action === "hide") continue;
    if (change.action === "update" && !change.newPhoto) continue;
    const slug =
      change.action === "create" ? createdCategorySlug(change) : change.slug;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name =
      change.name?.trim() || bySlug.get(slug)?.name || slug.replace(/-/g, " ");
    out.push({ slug, name, action: change.action });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shots.
// ---------------------------------------------------------------------------

/** A shot id, normalised; null when nothing usable is left. */
export function sanitizeShotId(value: unknown): string | null {
  let s = text(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) return null;
  if (!/^[a-z]/.test(s)) s = `shot-${s}`;
  s = s.slice(0, SHOT_ID_MAX).replace(/-+$/g, "");
  if (RESERVED_SHOT_IDS.has(s)) s = `${s}-shot`;
  return SHOT_ID_RE.test(s) ? s : null;
}

/** The shot id a `revamp-slot://` value names, as written. */
function slotIdOf(value: string): string | null {
  return value.startsWith(REVAMP_SLOT_PREFIX)
    ? value.slice(REVAMP_SLOT_PREFIX.length).trim()
    : null;
}

function slotRef(id: string): string {
  return `${REVAMP_SLOT_PREFIX}${id}`;
}

// ---------------------------------------------------------------------------
// The builder.
// ---------------------------------------------------------------------------

type Mode = "strict" | "lenient";

/** What the merchant is told a lenient fix did, grouped. */
type FixKind =
  | "section"
  | "link"
  | "claim"
  | "number"
  | "language"
  | "photo"
  | "opening"
  | "newsletter"
  | "scheme"
  | "menu"
  | "palette"
  | "colour"
  | "polarity"
  | "paletteKept"
  | "fonts"
  | "kept"
  | "page"
  | "copy"
  | "shots";

const FIX_NOTES: Record<FixKind, (n: number) => string> = {
  section: (n) =>
    n === 1
      ? "One section that could not be completed was left out."
      : "A few sections that could not be completed were left out.",
  link: () =>
    "Links that pointed at pages or products that will not exist were removed.",
  claim: () => "Wording that made claims you have not made was removed.",
  number: () =>
    "Numbers you did not give us, such as prices or delivery times, were removed.",
  language: () => "Text that was not in English was removed.",
  photo: () =>
    "Photos that belong to the theme were replaced with new photographs.",
  opening: () => "The homepage now opens with a full-width photograph.",
  newsletter: () => "The newsletter sign-up was moved to the end of the page.",
  scheme: () =>
    "Colour bands were adjusted so neighbouring sections do not match.",
  menu: () =>
    `The header menu was shortened to ${REVAMP_MAX_HEADER_LINKS} links.`,
  palette: () =>
    "Some of the new colours were adjusted so all text stays easy to read.",
  colour: (n) =>
    n === 1
      ? "A colour in the new design could not be used as written, so a matching colour was used in its place."
      : "A few colours in the new design could not be used as written, so matching colours were used in their place.",
  polarity: () =>
    "Your theme's page and text colours were kept, because the new ones would have changed how light or dark your pages are; the new accent colour was used.",
  paletteKept: () =>
    "The new colours did not pass the readability check, so your theme's colours were kept.",
  fonts: () => "Your theme's fonts were kept.",
  kept: () => "Your own sections were kept on every page.",
  page: () => "Page titles and search descriptions were completed.",
  copy: () =>
    "Some short texts were written for you from your store's details.",
  shots: () =>
    "Some photos reuse another photograph from the same shoot, to stay within the photo limit.",
};

/** The order notes are shown in: what matters most to the merchant first. */
const FIX_ORDER: FixKind[] = [
  "kept",
  "opening",
  "section",
  "link",
  "claim",
  "number",
  "language",
  "paletteKept",
  "polarity",
  "palette",
  "colour",
  "fonts",
  "photo",
  "shots",
  "newsletter",
  "scheme",
  "menu",
  "page",
  "copy",
];

interface WorkingSection {
  item: PageSectionItem;
  /** A merchant section kept by id (never rewritten). */
  kept: boolean;
  /** Where it was in the model's list, for issue sentences (1-based). */
  index: number;
}

interface WorkingPage {
  slug: string;
  label: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  create: boolean;
  pageId: string | null;
  snapshotPage: RevampSnapshotPage | null;
  sections: WorkingSection[];
  /** Copied from the previous plan: its problems are fixed silently. */
  copied: boolean;
}

interface RefContext {
  pageSlug: string;
  sectionType: string;
  context: string;
}

interface Ctx {
  mode: Mode;
  request: RevampRequest;
  snapshot: RevampSnapshot;
  previous: RevampSitePlan | null;
  newId: () => string;
  issues: string[];
  fixes: Map<FixKind, number>;
  evidence: string;
  numbers: Set<string>;
  names: string[];
  language: string;
  owned: Set<string>;
  replaceable: Set<string>;
  targets: {
    pages: Set<string>;
    categories: Set<string>;
    products: Set<string>;
  };
  hasProducts: boolean;
  /** The redesign creates at least one product (Apply features each one). */
  createsProducts: boolean;
  categoryBand: boolean;
  /** Shots the model described, by id. */
  modelShots: Map<
    string,
    RevampShot & { category: string | null; index: number }
  >;
  /** Shots created by the compiler (refills, categories, fixes). */
  autoShots: Map<string, RevampShot>;
  /** The merchant's products a shot may show, by goods key (B16). */
  goods: Map<string, RevampGoodsItem>;
  /** Every way the model may name a goods key, to the key. */
  goodsAliases: Map<string, string>;
  /** Where each referenced shot id is used first, to describe it by. */
  refContext: Map<string, RefContext>;
  /** Shot ids a refinement may redraw ("all" = every one). */
  redraw: Set<string> | "all";
  /**
   * The links whose own target is called Home (`homeNamedLinks`, B19), set
   * once the pages are built: a menu link labelled Home keeps one of these.
   */
  homeNamed: Set<string>;
  /**
   * ★★ The answer names prompt v5 or later (`revampAnswerPromptVersion`): its
   *   left-out choices and copy are picked for the store, its page colour is
   *   fitted to its direction, a copied instruction is refused and words on a
   *   plain field follow the page. False for an answer planned under v4,
   *   which compiles exactly as it always did.
   */
  v5: boolean;
  boundedPhotos: boolean;
  omittedPhotos: number;
  /** The redesign's seed (`revampDesignSeed`): the store and the redesign. */
  seed: string;
}

/** One option of `options`, picked for this redesign under `salt`. */
function pick<T>(ctx: Ctx, salt: string, options: readonly T[]): T {
  return revampSeededPick(`${ctx.seed}|${salt}`, options);
}

/**
 * ★★ THE COLOUR OF WORDS ON A PLAIN FIELD FOLLOWS THE FIELD (v5). A section's
 * `theme` is the colour of its words: over a photograph the storefront picks
 * whichever reads (`MediaTone`), so it is a free choice there; on the page or
 * a plain field it must read against that field. Light words on a light page
 * cannot be read, and with "choose one: light or dark" printed (the v4
 * example's "dark" happened to be safe), the compiler holds them to the
 * field: dark words on a light page, light on a dark one, or against the
 * field's own colour when it has one.
 */
export function revampTextThemeFor(
  field: string | null | undefined,
  themePage: string,
): "light" | "dark" {
  const hex = normalizeRevampHex(field ?? "") ?? normalizeRevampHex(themePage);
  return !hex || isLightColour(hex) ? "dark" : "light";
}

/** Dark or light words for the page itself (the theme's polarity, which a redesign keeps). */
function pageTextTheme(ctx: Ctx, field?: unknown): "light" | "dark" {
  return revampTextThemeFor(text(field), ctx.snapshot.theme.palette.page);
}

/**
 * A trust bar item's icon, when the answer left it out: the one its words
 * name (delivery a truck, returns the arrows), else one picked for the store.
 */
function uspIconFor(
  ctx: Ctx,
  item: Record<string, unknown>,
  salt: string,
): string {
  const words = `${text(item.title)} ${text(item.subtitle)}`.toLowerCase();
  // ★ Payment first: "Cash on delivery" is a way to pay, not a delivery.
  const named: Array<[RegExp, string]> = [
    [/\b(pay\w*|checkout|cash on delivery|cod|secure)\b/, "shield"],
    [/\b(deliver\w*|shipping|ships|dispatch\w*|courier)\b/, "truck"],
    [/\b(returns?|exchanges?|refunds?)\b/, "refresh"],
    [/\b(pick ?up|collect\w*|hours?|same day)\b/, "clock"],
    [/\b(gifts?|gifting|wrap\w*)\b/, "gift"],
    [/\b(support|help|call|whatsapp|chat)\b/, "headphones"],
    [/\b(plants?|leaf|leaves|garden\w*|farms?|herbs?)\b/, "leaf"],
  ];
  for (const [re, icon] of named) if (re.test(words)) return icon;
  return pick(ctx, salt, ["star", "sparkles", "heart"]);
}

/**
 * ★★ A CHOICE THE ANSWER LEFT OUT IS PICKED FOR THE STORE (v5). Each setting
 * of `REVAMP_SECTION_CHOICES` the answer did not set to a value the validator
 * keeps (left out, or the example's "choose one: ..." copied) is picked from
 * the same closed list for this store, where the validator would have put
 * one default for every store. One pick per section for all its items, so a
 * carousel's slides agree; a story's side alternates with the section's, a
 * row with a photo is an image row, and a trust bar icon follows its words.
 * Then the words on a plain field are held to it (`revampTextThemeFor`).
 */
function fillSectionChoices(
  ctx: Ctx,
  pageSlug: string,
  index: number,
  type: HomepageSectionType,
  config: Record<string, unknown>,
): void {
  const table = REVAMP_SECTION_CHOICES[type];
  const salt = `${pageLabel(pageSlug)}|${index}|${type}`;
  for (const [key, rule] of Object.entries(table?.fields ?? {})) {
    const kept = readChoice(config[key], rule);
    config[key] =
      kept !== undefined ? kept : pick(ctx, `${salt}.${key}`, rule.options);
  }
  const spec = SECTION_BLOCKS[type];
  const list = spec ? config[spec.key] : undefined;
  if (spec && table?.items && Array.isArray(list)) {
    list.forEach((item, i) => {
      if (!isRecord(item)) return;
      for (const [key, rule] of Object.entries(table.items!)) {
        const kept = readChoice(item[key], rule);
        if (kept !== undefined) {
          item[key] = kept;
        } else if (type === "usp_bar" && key === "icon") {
          item[key] = uspIconFor(ctx, item, `${salt}.${spec.key}[${i}].icon`);
        } else if (type === "accordion" && key === "type") {
          item[key] = text(item.image_url).trim() ? "image" : "text";
        } else if (type === "media_text" && key === "media_position") {
          // ★ Stories alternate sides with the band above them.
          const first = config.media_position === "right" ? "right" : "left";
          const other = first === "right" ? "left" : "right";
          item[key] = i % 2 === 0 ? other : first;
        } else {
          item[key] = pick(ctx, `${salt}.${spec.key}.${key}`, rule.options);
        }
      }
    });
  }
  holdTextToField(ctx, type, config);
}

/** `revampTextThemeFor` applied to a section's words that sit on no photograph. */
function holdTextToField(
  ctx: Ctx,
  type: HomepageSectionType,
  config: Record<string, unknown>,
): void {
  const hasPhoto = (node: Record<string, unknown>) =>
    !!text(node.image_url).trim();
  if (type === "usp_bar" || type === "ticker") {
    config.theme = pageTextTheme(ctx);
    return;
  }
  if (type === "hero") {
    const overPhoto =
      (config.variant === "fullbleed" || config.variant === "minimal") &&
      hasPhoto(config);
    if (!overPhoto) config.theme = pageTextTheme(ctx, config.background);
    return;
  }
  if (type === "promo_banner" && !hasPhoto(config)) {
    config.theme = pageTextTheme(ctx);
    return;
  }
  const items =
    type === "tile_grid"
      ? config.tiles
      : type === "hero_carousel"
        ? config.slides
        : undefined;
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!isRecord(item)) continue;
    // A split carousel's copy sits on a colour field beside its photograph.
    const onPhoto =
      hasPhoto(item) &&
      !(type === "hero_carousel" && config.layout === "split");
    if (!onPhoto) item.theme = pageTextTheme(ctx, item.background);
  }
}

/**
 * Copy a v5 answer left out that the validator would fill with one line for
 * every store: a newsletter section's button and thank-you line, picked for
 * the store from `REVAMP_NEUTRAL_COPY`.
 */
function fillSectionCopy(
  ctx: Ctx,
  pageSlug: string,
  index: number,
  type: HomepageSectionType,
  config: Record<string, unknown>,
): void {
  if (type !== "newsletter") return;
  const salt = `${pageLabel(pageSlug)}|${index}|${type}`;
  if (!text(config.button_label).trim()) {
    config.button_label = pick(
      ctx,
      `${salt}.button_label`,
      REVAMP_NEUTRAL_COPY.newsletterButton,
    );
  }
  if (!text(config.success_message).trim()) {
    config.success_message = pick(
      ctx,
      `${salt}.success_message`,
      REVAMP_NEUTRAL_COPY.newsletterThanks,
    );
  }
}

function issue(ctx: Ctx, sentence: string, fix: FixKind | null): void {
  if (ctx.issues.length < MAX_ISSUES) ctx.issues.push(sentence);
  if (fix) ctx.fixes.set(fix, (ctx.fixes.get(fix) ?? 0) + 1);
}

/** A problem only the strict pass reports (a style preference, not a defect). */
function strictOnly(ctx: Ctx, sentence: string): void {
  if (ctx.mode === "strict" && ctx.issues.length < MAX_ISSUES) {
    ctx.issues.push(sentence);
  }
}

/**
 * A page rule's problem. ★ A page copied from the previous plan is not the
 * model's to fix (it was not asked to write that page), so its problems are
 * fixed with no repair sentence; the merchant's note still counts the fix.
 */
function pageIssue(
  ctx: Ctx,
  page: WorkingPage,
  sentence: string,
  fix: FixKind | null,
): void {
  if (!page.copied) {
    issue(ctx, sentence, fix);
    return;
  }
  if (fix) ctx.fixes.set(fix, (ctx.fixes.get(fix) ?? 0) + 1);
}

function sectionWhere(
  page: WorkingPage,
  index: number,
  type: string,
  field?: string,
): string {
  return `Page "${page.label}" section ${index} (${type})${field ? ` ${field}` : ""}`;
}

// ── Evidence ────────────────────────────────────────────────────────────────
// ★ The claim evidence is revampClaimEvidence (copy-checks.ts), shared with the
//   checks so the copy the compiler accepts is judged against the same words
//   afterwards (output-3). It carries the confirmed category changes, the
//   merchant's own catalogue names and the store's facts.

function numbersIn(value: string): string[] {
  return (value.match(/\d+(?:[.,]\d+)*/g) ?? []).map(normalizeNumber);
}

function normalizeNumber(value: string): string {
  const plain = value.replace(/,/g, "");
  // "249.50" and 249.5 are one price, "1,499.00" and 1499 another.
  return plain.includes(".")
    ? plain.replace(/0+$/, "").replace(/\.$/, "")
    : plain;
}

function numberEvidence(
  request: RevampRequest,
  snapshot: RevampSnapshot,
  evidence: string,
): Set<string> {
  const out = new Set(numbersIn(evidence));
  for (const product of request.products) {
    for (const size of product.sizes) {
      for (const n of numbersIn(size.label)) out.add(n);
      out.add(normalizeNumber(String(size.price)));
      if (size.mrp !== null) out.add(normalizeNumber(String(size.mrp)));
    }
    out.add(String(product.sizes.length));
  }
  out.add(String(request.products.length));
  out.add(String(snapshot.products.length));
  out.add(String(snapshot.categories.length));
  for (const n of numbersIn(snapshot.storeName)) out.add(n);
  return out;
}

// ★ The shop's own names (revampStoreNames in copy-checks.ts) are shared with
//   the checks, so copy the compiler reads as English is read the same way
//   afterwards (output-4).

// ── Copy ────────────────────────────────────────────────────────────────────

/**
 * One shopper-facing text, cleaned (silently: dashes, spaces) and checked
 * for language, claims and invented numbers. Returns the text to keep: the
 * same on a pass, the repaired text after a fix ("" when nothing is left).
 */
function checkCopy(
  ctx: Ctx,
  value: string,
  where: string,
  silent = false,
  optional = false,
): string {
  let out = cleanRevampCopy(value);
  if (!out) return "";
  // ★★ An example's instruction copied as it was printed (v5) is not the
  //    store's words: it is asked for again, and never shown to a shopper.
  //    ★ The sentence names the field and the instruction's own opening
  //    words, never the rest: words written after it are the store's, and
  //    the runner logs these sentences (review fix, 25 Oct).
  if (ctx.v5 && isRevampExampleInstruction(out)) {
    if (!silent) {
      issue(
        ctx,
        `${where} starts with an example's instruction ("${revampExampleInstructionPrefix(out)}"). Write this store's own words in its place, from the merchant's facts.`,
        null,
      );
    }
    return "";
  }
  if (!readsAsLanguage(withoutStoreNames(out, ctx.names), ctx.language)) {
    if (!silent) {
      issue(
        ctx,
        `${where} is not in English. Write it in English (the shop's and products' own names may stay as they are).`,
        "language",
      );
    }
    return "";
  }
  const claims = unsupportedClaimsIn(out, ctx.evidence);
  if (claims.length) {
    if (!silent && !optional) {
      issue(
        ctx,
        `${where} claims ${claims.map((c) => `"${c}"`).join(", ")} but the merchant never said so. Remove the claim or use only what the merchant stated.`,
        "claim",
      );
    }
    out = withoutUnsupportedClaims(out, ctx.evidence).text;
    if (!out) return "";
  }
  const numbers = [...new Set(numbersIn(out))].filter(
    (n) => !ctx.numbers.has(n),
  );
  if (numbers.length) {
    if (!silent) {
      issue(
        ctx,
        `${where} states ${numbers.join(", ")}, which the merchant never gave. Use only numbers from the brief, the products and the store facts, and write small counts in words.`,
        "number",
      );
    }
    out = sentences(out)
      .filter((s) => numbersIn(s).every((n) => ctx.numbers.has(n)))
      .join(" ")
      .trim();
  }
  return out;
}

function sentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Decodes the few entities a model writes, for text checks only. */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface RichBlock {
  tag: string;
  html: string;
}

/**
 * A revamp's rich text, rebuilt from an allowlist: p, headings, lists,
 * emphasis, breaks and links that reach a real target, no attributes. A
 * script or style element goes with its content; any other tag goes and its
 * text stays. ★ Defence in depth: the storefront sanitises again at render.
 */
function sanitizeRichText(
  html: string,
  linkOk: (href: string) => string | null,
  onBadLink: (href: string) => void,
): string {
  const source = html
    .replace(
      /<(script|style|iframe|object|embed|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<!--[\s\S]*?-->/g, " ");
  const out: string[] = [];
  const open: string[] = [];
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source))) {
    out.push(escapeText(withoutLongDashes(source.slice(last, match.index))));
    last = tagRe.lastIndex;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (!RICH_TEXT_TAGS.has(tag)) continue;
    if (tag === "br") {
      if (!closing) out.push("<br>");
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (tag === "a") {
      const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
        match[3],
      );
      const value = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
      const ok = value ? linkOk(value) : null;
      if (!ok) {
        if (value) onBadLink(value);
        continue;
      }
      out.push(`<a href="${ok}">`);
      open.push("a");
      continue;
    }
    out.push(`<${tag}>`);
    open.push(tag);
  }
  out.push(escapeText(withoutLongDashes(source.slice(last))));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("").replace(/\s+/g, " ").trim();
}

/** A rich text's top-level blocks (paragraphs, headings, lists). */
function richBlocks(html: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  const re = /<(p|h2|h3|h4|ul|ol)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = re.exec(html))) {
    const loose = html.slice(last, match.index).trim();
    if (loose) blocks.push({ tag: "p", html: loose });
    blocks.push({ tag: match[1], html: match[2] });
    last = re.lastIndex;
  }
  const tail = html.slice(last).trim();
  if (tail) blocks.push({ tag: "p", html: tail });
  return blocks;
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** A rich text checked block by block: a block with a problem is dropped. */
function checkRichText(ctx: Ctx, html: string, where: string): string {
  const kept: string[] = [];
  for (const block of richBlocks(html)) {
    const plain = plainText(block.html);
    if (!plain) continue;
    const checked = checkCopy(ctx, plain, where);
    if (checked !== cleanRevampCopy(plain)) continue;
    kept.push(`<${block.tag}>${block.html}</${block.tag}>`);
  }
  return kept.join("");
}

// ── Links ───────────────────────────────────────────────────────────────────

function isLinkKey(key: string): boolean {
  return key === "href" || key.endsWith("_href");
}

const LINK_HELP =
  'Link only to "/", "/shop", "/collections/<category>", "/shop/<product>" or "/<page>" from <link_targets>, the blog or the enquiry form ("/blogs", "/enquiries"), or leave it "".';

// ---------------------------------------------------------------------------
// One new section.
// ---------------------------------------------------------------------------

function parseConfig(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) return clone(raw);
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The model's section style, as the registry stores it. */
function readStyle(raw: unknown, type: string): SectionStyle | undefined {
  if (!isRecord(raw)) return undefined;
  const scheme = isSectionScheme(raw.scheme) ? raw.scheme : undefined;
  const padding = (REVAMP_SECTION_PADDINGS as readonly unknown[]).includes(
    raw.padding,
  )
    ? (raw.padding as "sm" | "md" | "lg")
    : undefined;
  const width = (REVAMP_SECTION_WIDTHS as readonly unknown[]).includes(
    raw.width,
  )
    ? (raw.width as "contained" | "full")
    : undefined;
  const style = validateSectionStyle(
    { scheme, padding_y: padding, width },
    type,
  );
  if (style?.scheme && !style.padding_y) style.padding_y = "md";
  return style;
}

/**
 * The list a section's items go under, how many it takes and each item's
 * fields, for a repair sentence (output-1); "" for a section with no list.
 * ★ The list key, bounds and fields are the registry's and the prompt's
 *   example's, so the sentence names exactly what the validator keeps.
 */
function listHelp(
  type: HomepageSectionType,
  misplaced: readonly string[],
): string {
  const spec = SECTION_BLOCKS[type];
  if (!spec) return "";
  const list = revampSectionExample(type)[spec.key];
  const first = Array.isArray(list) ? list[0] : undefined;
  const fields = isRecord(first) ? Object.keys(first) : [];
  const not = misplaced.length
    ? ` (not ${misplaced.map((key) => `config.${key}`).join(", ")})`
    : "";
  const each = fields.length
    ? `, each with the fields ${fields.join(", ")}`
    : "";
  const photo = fields.includes("image_url")
    ? `; a photo goes in image_url as ${REVAMP_SLOT_PREFIX}<shot id>`
    : "";
  return ` Its list is config.${spec.key}${not}: ${spec.min} to ${spec.max} items${each}${photo}.`;
}

function buildNewSection(
  ctx: Ctx,
  page: WorkingPage,
  index: number,
  rawSection: Record<string, unknown>,
): WorkingSection | null {
  const rawType = text(rawSection.type).trim();
  if (!(REVAMP_SECTION_TYPES as readonly string[]).includes(rawType)) {
    issue(
      ctx,
      `Page "${page.label}" section ${index}: "${rawType || "(no type)"}" is not a section type a redesign may use. Use one of: ${REVAMP_SECTION_TYPES.join(", ")}, or {keep: "<id>"} for the merchant's own section.`,
      "section",
    );
    return null;
  }
  const type = rawType as HomepageSectionType;
  const config = parseConfig(rawSection.configJson);
  if (!config) {
    issue(
      ctx,
      `${sectionWhere(page, index, type)}: configJson must be a JSON object, written as a string, with exactly the fields of the ${type} example.`,
      "section",
    );
    return null;
  }

  // ★ A list written under a key the section does not have (a tile grid's
  //   tiles as "items") is taken out before its photos are read: each photo
  //   in it would otherwise be told to "leave it empty", the opposite of the
  //   fix. The sentences below name the right key and the item fields.
  const fieldsOf = EMPTY_CONFIG[type] as unknown as Record<string, unknown>;
  const misplaced = SECTION_BLOCKS[type]
    ? Object.keys(config).filter(
        (key) => Array.isArray(config[key]) && !(key in fieldsOf),
      )
    : [];
  for (const key of misplaced) delete config[key];

  // ★★ v5: a choice left out is picked for the store, before the frames are
  //    read from it (a gallery's layout, a story's ratio).
  if (ctx.v5) fillSectionChoices(ctx, page.slug, index, type, config);

  // Values only one answer is right for, set silently.
  if (type === "featured_products") {
    // ★★ Named products when nothing featured will be there (output-5): a
    //    "featured" band on a store whose own products were never featured
    //    publishes empty. No real product at all is the rule below.
    const binding = revampFeaturedBinding(ctx.snapshot, {
      createsProducts: ctx.createsProducts,
      limit: Number(config.limit),
    });
    config.source = binding?.source ?? "featured";
    config.product_ids =
      binding && binding.source === "manual" ? binding.productIds : [];
    config.category_id = null;
  }
  if (type === "product_spotlight") {
    config.source = "featured";
    config.product_id = null;
  }
  if (type === "shop_by_category") {
    config.source = "all";
    config.category_ids = [];
  }

  if (PRODUCT_SECTION_TYPES.has(type) && !ctx.hasProducts) {
    issue(
      ctx,
      `${sectionWhere(page, index, type)}: the store will have no real products to show here (the merchant gave none and every published product is a theme sample). Leave product sections out.`,
      "section",
    );
    return null;
  }
  if (type === "shop_by_category" && !ctx.categoryBand) {
    issue(
      ctx,
      `${sectionWhere(page, index, type)}: a category band needs at least two real categories and no theme sample category left showing. Leave it out.`,
      "section",
    );
    return null;
  }

  // Images, links and copy, field by field.
  for (const leaf of stringLeaves(config)) {
    const key = lastKey(leaf.path);
    const field = `config.${formatPath(leaf.path)}`;
    if (key === "video_url" || key === "mobile_image_url") {
      // ★ A revamp draws stills, and the phone crop is made from the main
      //   photo (a binding's phonePath), never a second picture.
      setAt(config, leaf.path, "");
      continue;
    }
    if (isImageKey(key)) {
      setAt(
        config,
        leaf.path,
        checkImage(ctx, page, index, type, field, leaf, config),
      );
      continue;
    }
    if (isLinkKey(key)) {
      const ok = checkRevampLink(leaf.value, ctx.targets);
      if (ok === null) {
        issue(
          ctx,
          `${sectionWhere(page, index, type, field)} "${clipText(leaf.value, 80)}" is not a page, category or product that will exist after Apply. ${LINK_HELP}`,
          "link",
        );
        setAt(config, leaf.path, "");
        if (key === "cta_href")
          setAt(config, [...leaf.path.slice(0, -1), "cta_label"], "");
      } else {
        setAt(config, leaf.path, ok);
      }
      continue;
    }
    if (type === "rich_text" && key === "html") {
      const sanitized = sanitizeRichText(
        leaf.value,
        (href) => checkRevampLink(href, ctx.targets) || null,
        (href) =>
          issue(
            ctx,
            `${sectionWhere(page, index, type, field)} links to "${clipText(href, 80)}", which will not exist after Apply. ${LINK_HELP}`,
            "link",
          ),
      );
      setAt(
        config,
        leaf.path,
        checkRichText(ctx, sanitized, sectionWhere(page, index, type, field)),
      );
      continue;
    }
    const listItem = typeof leaf.path[leaf.path.length - 1] === "number";
    if (
      (!listItem && COPY_KEYS.has(key)) ||
      (listItem && COPY_LIST_KEYS.has(key))
    ) {
      setAt(
        config,
        leaf.path,
        checkCopy(
          ctx,
          leaf.value,
          sectionWhere(page, index, type, field),
          false,
          /^(alt|image_alt|caption|eyebrow|subheading|subtitle)$/.test(key),
        ),
      );
    }
  }

  // A button with nowhere to go is not a button.
  for (const leaf of stringLeaves(config)) {
    if (lastKey(leaf.path) !== "cta_href" || leaf.value) continue;
    setAt(config, [...leaf.path.slice(0, -1), "cta_label"], "");
  }
  if (ctx.v5) fillSectionCopy(ctx, page.slug, index, type, config);

  const validated = validateConfig(type, config, "publish");
  if ("error" in validated) {
    issue(
      ctx,
      `${sectionWhere(page, index, type)}: ${validated.error}${listHelp(type, misplaced)} Fill the section from the merchant's facts or leave it out.`,
      "section",
    );
    return null;
  }
  if (misplaced.length) {
    // The section stands without them, so the merchant hears nothing.
    issue(
      ctx,
      `${sectionWhere(page, index, type)}: ${misplaced.map((key) => `config.${key}`).join(", ")} is not a field of ${type} and was left out.${listHelp(type, misplaced)}`,
      null,
    );
  }
  const style = readStyle(rawSection.style, type);
  return {
    item: {
      id: ctx.newId(),
      type,
      enabled: true,
      config: validated.config,
      ...(style ? { style } : {}),
    },
    kept: false,
    index,
  };
}

/** One image field of a new section: "", an owned photo or a known shot. */
function checkImage(
  ctx: Ctx,
  page: WorkingPage,
  index: number,
  type: string,
  field: string,
  leaf: { value: string; path: Path },
  config: Record<string, unknown>,
): string {
  const value = leaf.value.trim();
  if (!value) return "";
  const frameKey = revampFrameKeyFor(type, config, leaf.path);
  const rawId = slotIdOf(value);
  if (rawId !== null) {
    const id = sanitizeShotId(rawId);
    if (!frameKey) {
      issue(
        ctx,
        `${sectionWhere(page, index, type, field)} cannot hold a new photograph; leave it "".`,
        "photo",
      );
      return "";
    }
    if (!id) {
      issue(
        ctx,
        `${sectionWhere(page, index, type, field)} names "${clipText(value, 60)}", which is not a valid shot id. Shot ids are lowercase letters, digits and hyphens, starting with a letter.`,
        "photo",
      );
      return autoShotRef(ctx, page.slug, type, config, leaf.path);
    }
    if (id !== rawId) {
      issue(
        ctx,
        `${sectionWhere(page, index, type, field)} names shot "${rawId}"; write it as "${id}" (lowercase letters, digits and hyphens).`,
        "photo",
      );
    }
    noteRef(ctx, id, page.slug, type, config, leaf.path);
    return slotRef(id);
  }
  if (ctx.owned.has(value)) return value;
  issue(
    ctx,
    `${sectionWhere(page, index, type, field)} uses "${clipText(value, 80)}", which is not a photo the store owns (theme photos, earlier Mink photos and outside links are never used). Use "" or ${REVAMP_SLOT_PREFIX}<shot id> with a shot you describe in shots.`,
    "photo",
  );
  return frameKey ? autoShotRef(ctx, page.slug, type, config, leaf.path) : "";
}

function noteRef(
  ctx: Ctx,
  id: string,
  pageSlug: string,
  type: string,
  config: unknown,
  path: Path,
): void {
  if (ctx.refContext.has(id)) return;
  const fake: PageSectionItem = {
    id: "",
    type: type as HomepageSectionType,
    enabled: true,
    config: config as PageSectionItem["config"],
  };
  ctx.refContext.set(id, {
    pageSlug,
    sectionType: type,
    context: sectionContext(fake, path),
  });
}

/** A fresh compiler-made shot for one field, described from its section. */
function autoShotRef(
  ctx: Ctx,
  pageSlug: string,
  type: string,
  config: unknown,
  path: Path,
): string {
  const priorIds = new Set((ctx.previous?.shots ?? []).map((s) => s.id));
  // ★ Never another shot's id (the model's, an earlier fix's, a refill's or
  //   the previous plan's), and always within the id limit.
  const id = uniqueId(
    `${pageLabel(pageSlug)}-${type}`,
    (candidate) =>
      ctx.modelShots.has(candidate) ||
      ctx.autoShots.has(candidate) ||
      ctx.refContext.has(candidate) ||
      priorIds.has(candidate),
  );
  noteRef(ctx, id, pageSlug, type, config, path);
  ctx.autoShots.set(id, {
    id,
    purpose: "content",
    subject: "",
    artDirection: "",
    aspectRatio: "1:1",
    people: "none",
    goods: "none",
    productKeys: [],
  });
  return slotRef(id);
}

// ---------------------------------------------------------------------------
// A kept merchant section: word for word, its replaceable photos refilled.
// ---------------------------------------------------------------------------

function keepMerchantSection(
  ctx: Ctx,
  pageSlug: string,
  section: PageSectionItem,
): PageSectionItem {
  const out = clone(section);
  for (const refill of refillsOf(pageSlug, section, ctx.replaceable)) {
    setAt(out.config, refill.path, slotRef(refill.shotId));
    if (lastKey(refill.path) === "image_url") {
      const phone = phonePathFor(out.type, refill.path, refill.frame.aspect);
      if (phone) {
        const current = text(getAt(out.config, phone));
        if (!current.trim() || isReplaceable(current, ctx.replaceable)) {
          setAt(out.config, phone, "");
        }
      }
    }
    ctx.refContext.set(refill.shotId, {
      pageSlug,
      sectionType: section.type,
      context: refill.context,
    });
  }
  // ★ Whatever replaceable photo is left is cleared rather than left as a
  //   theme file: a logo (a mark is somebody's brand, never redrawn) or a
  //   phone photo beside an empty main photo.
  for (const leaf of sectionImageLeaves(out)) {
    if (isReplaceable(leaf.value, ctx.replaceable)) {
      setAt(out.config, leaf.path, "");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page rules.
// ---------------------------------------------------------------------------

function merchantSectionsOf(
  page: RevampSnapshotPage | null,
): PageSectionItem[] {
  if (!page) return [];
  return page.sections.filter(
    (s) => page.owners[s.id] === "merchant" || s.type === "custom_code",
  );
}

function enabledSections(page: WorkingPage): WorkingSection[] {
  return page.sections.filter((s) => s.item.enabled !== false);
}

/**
 * Every merchant section of the store's page is on the planned page. ★ One
 * the model forgot goes back before a closing newsletter, which stays last.
 */
function ensureMerchantSections(ctx: Ctx, page: WorkingPage): void {
  // ★ Only a KEPT section counts: a new section whose id happens to match a
  //   merchant's must not stand in for it (ids are made unique later).
  const present = new Set(
    page.sections.filter((s) => s.kept).map((s) => s.item.id),
  );
  for (const section of merchantSectionsOf(page.snapshotPage)) {
    if (present.has(section.id)) continue;
    pageIssue(
      ctx,
      page,
      `Page "${page.label}" must keep the merchant's own section "${section.id}" (${section.type}); add {"keep": "${section.id}"} where it should appear.`,
      "kept",
    );
    const restored: WorkingSection = {
      item: keepMerchantSection(ctx, page.slug, section),
      kept: true,
      index: page.sections.length + 1,
    };
    const enabled = enabledSections(page);
    const last = enabled[enabled.length - 1];
    if (
      last?.item.type === "newsletter" &&
      restored.item.type !== "newsletter"
    ) {
      page.sections.splice(page.sections.indexOf(last), 0, restored);
    } else {
      page.sections.push(restored);
    }
  }
}

/** One newsletter at most, and it closes the page. */
function enforceNewsletter(ctx: Ctx, page: WorkingPage): void {
  const letters = page.sections.filter(
    (s) => s.item.type === "newsletter" && s.item.enabled !== false,
  );
  if (letters.length === 0) return;
  const merchant = letters.filter((s) => s.kept);
  const fresh = letters.filter((s) => !s.kept);
  const drop = new Set<WorkingSection>();
  if (merchant.length > 0) {
    for (const s of fresh) {
      pageIssue(
        ctx,
        page,
        `${sectionWhere(page, s.index, "newsletter")}: the page already keeps the merchant's own newsletter section; do not add a second one.`,
        "section",
      );
      drop.add(s);
    }
  } else {
    for (const s of fresh.slice(1)) {
      pageIssue(
        ctx,
        page,
        `${sectionWhere(page, s.index, "newsletter")}: a page has at most one newsletter section.`,
        "section",
      );
      drop.add(s);
    }
  }
  page.sections = page.sections.filter((s) => !drop.has(s));
  const closing = merchant[merchant.length - 1] ?? fresh[0];
  const enabled = enabledSections(page);
  if (enabled[enabled.length - 1] !== closing) {
    if (!closing.kept) {
      pageIssue(
        ctx,
        page,
        `${sectionWhere(page, closing.index, "newsletter")}: a newsletter section may only be the last section of a page; move it to the end.`,
        "newsletter",
      );
    }
    page.sections = [...page.sections.filter((s) => s !== closing), closing];
  }
}

/**
 * Two or three bands in a scheme, never two neighbours in the same one.
 * Re-applied after the photo pass, with deterministic fixes in both modes.
 */
function enforceSchemes(page: WorkingPage, isHome: boolean): void {
  const enabled = enabledSections(page);
  const opening = isHome ? enabled[0] : undefined;
  if (opening && !opening.kept && opening.item.style?.scheme) {
    delete opening.item.style.scheme;
  }
  let previous: WorkingSection | null = null;
  for (const s of enabled) {
    const scheme = s.item.style?.scheme;
    if (!scheme) {
      previous = null;
      continue;
    }
    if (previous && previous.item.style?.scheme === scheme) {
      const target: WorkingSection | null = !s.kept
        ? s
        : !previous.kept
          ? previous
          : null;
      if (target) {
        delete target.item.style!.scheme;
        if (target === s) {
          previous = null;
          continue;
        }
      }
    }
    previous = s;
  }
  const schemed = enabled.filter((s) => s.item.style?.scheme);
  // ★★ ONLY THE MODEL'S OWN SECTIONS COUNT TOWARD THE EXCESS (output-7). A
  //    kept section is the merchant's and is never rewritten, so a page whose
  //    own sections already wear four schemes was told "use two or three" on
  //    every strict pass, a sentence the model cannot act on, and each run
  //    spent both repairs before the lenient pass took the same plan. The
  //    kept sections take their share first; the model's are held to what is
  //    left, reported (it can remove its own) and trimmed from the end.
  const keptSchemed = schemed.filter((s) => s.kept).length;
  const fresh = schemed.filter((s) => !s.kept);
  const room = Math.max(0, 3 - keptSchemed);
  if (fresh.length > room) {
    let left = fresh.length;
    for (const s of [...fresh].reverse()) {
      if (left <= room) break;
      delete s.item.style!.scheme;
      left -= 1;
    }
  }
  if (isHome && !page.copied && enabled.length >= 4) {
    let count = enabled.filter((s) => s.item.style?.scheme).length;
    for (let i = 1; i < enabled.length && count < 2; i += 1) {
      const section = enabled[i];
      if (section.kept || section.item.style?.scheme) continue;
      const neighbours = [
        enabled[i - 1]?.item.style?.scheme,
        enabled[i + 1]?.item.style?.scheme,
      ];
      const scheme = (["soft", "tint", "accent", "inverse"] as const).find(
        (candidate) => !neighbours.includes(candidate),
      );
      if (!scheme) continue;
      section.item.style = { ...section.item.style, scheme };
      count += 1;
    }
  }
}

/**
 * The homepage opens with a photograph filling the band: a fullbleed hero
 * with an image, or a carousel of two or three slides each with an image,
 * at large or screen height and full width.
 */
function enforceOpening(ctx: Ctx, page: WorkingPage): void {
  const enabled = enabledSections(page);
  const first = enabled[0];
  if (first && !first.kept) {
    const s = first.item;
    // ★ A carousel with fewer than two photographs is a hero; one with more
    //   keeps its first three photographed slides, on the full layout.
    if (s.type === "hero_carousel") convertSingleSlide(ctx, page, first);
    if (s.type === "hero" || s.type === "hero_carousel") {
      const c = s.config as unknown as Record<string, unknown>;
      if (s.type === "hero") {
        c.variant = "fullbleed";
        if (!text(c.image_url).trim()) {
          pageIssue(
            ctx,
            page,
            `${sectionWhere(page, first.index, "hero", "config.image_url")}: the homepage opens with a photograph filling the band; give the hero an image (${REVAMP_SLOT_PREFIX}<shot id> with a shot you describe).`,
            "opening",
          );
          c.image_url = autoShotRef(ctx, page.slug, "hero", c, ["image_url"]);
        }
      } else {
        const slides = Array.isArray(c.slides)
          ? (c.slides as Record<string, unknown>[])
          : [];
        delete c.layout;
        c.slides = slides
          .filter((slide) => text(slide.image_url).trim())
          .slice(0, 3);
      }
      if (c.height !== "large" && c.height !== "screen") {
        // ★ v5: the opening's height is picked for the store, not "large"
        //   for everyone (it is the hero axis of the design's fingerprint).
        c.height = ctx.v5
          ? pick(ctx, "opening.height", ["large", "screen"])
          : "large";
      }
      s.style = { ...(s.style ?? {}), width: "full" };
      delete s.style.scheme;
      return;
    }
  }
  if (first && first.kept && keptOpeningOk(first.item)) return;
  pageIssue(
    ctx,
    page,
    `The homepage must open with a full-band photograph: make its first section a hero (variant "fullbleed", with an image, height "large" or "screen") or a hero_carousel of two or three slides, each with an image.`,
    "opening",
  );
  page.sections.unshift({
    item: openingHero(ctx, page.slug),
    kept: false,
    index: 0,
  });
}

/** A carousel left with one slide (or none) becomes a fullbleed hero. */
function convertSingleSlide(
  ctx: Ctx,
  page: WorkingPage,
  section: WorkingSection,
): void {
  const c = section.item.config as unknown as Record<string, unknown>;
  const slides = Array.isArray(c.slides)
    ? (c.slides as Record<string, unknown>[])
    : [];
  const withImages = slides.filter((slide) => text(slide.image_url).trim());
  if (withImages.length >= 2) return;
  const slide = withImages[0] ?? slides[0] ?? {};
  const hero: Record<string, unknown> = {
    variant: "fullbleed",
    height: c.height === "screen" ? "screen" : "large",
    heading: text(slide.heading),
    subheading: text(slide.subheading),
    cta_label: text(slide.cta_label),
    cta_href: text(slide.cta_href),
    image_url: text(slide.image_url),
    video_url: "",
    badge_text: "",
    background: text(slide.background),
    theme: slide.theme === "light" ? "light" : "dark",
    alignment: ctx.v5
      ? pick(ctx, "opening.alignment", ["left", "center"])
      : "left",
  };
  if (!text(hero.image_url).trim()) {
    pageIssue(
      ctx,
      page,
      `${sectionWhere(page, section.index, "hero_carousel", "config.slides")}: the opening carousel needs two or three slides, each with an image (${REVAMP_SLOT_PREFIX}<shot id>).`,
      "opening",
    );
    hero.image_url = autoShotRef(ctx, page.slug, "hero", hero, ["image_url"]);
  }
  const validated = validateConfig("hero", hero, "publish");
  if ("error" in validated) return;
  section.item.type = "hero";
  section.item.config = validated.config;
}

function keptOpeningOk(item: PageSectionItem): boolean {
  const c = item.config as unknown as Record<string, unknown>;
  const height = c.height === "large" || c.height === "screen";
  const full = item.style?.width === "full";
  if (item.type === "hero") {
    return (
      c.variant === "fullbleed" && !!text(c.image_url).trim() && height && full
    );
  }
  if (item.type === "hero_carousel") {
    const slides = Array.isArray(c.slides)
      ? (c.slides as Record<string, unknown>[])
      : [];
    return (
      slides.length >= 2 &&
      slides.length <= 3 &&
      slides.every((s) => !!text(s.image_url).trim()) &&
      c.layout !== "split" &&
      height &&
      full
    );
  }
  return false;
}

/** The opening a lenient pass puts in front of a homepage that has none. */
function openingHero(ctx: Ctx, pageSlug: string): PageSectionItem {
  const subheading =
    checkCopy(ctx, ctx.snapshot.brand.tagline ?? "", "", true) ||
    checkCopy(ctx, clipText(ctx.request.brief.business, 140), "", true);
  // ★ v5: the opening the compiler writes is picked for the store too: its
  //   height, words' colour, side and button, never one opening for all.
  const config: Record<string, unknown> = {
    variant: "fullbleed",
    height: ctx.v5 ? pick(ctx, "opening.height", ["large", "screen"]) : "large",
    heading: ctx.snapshot.storeName,
    subheading,
    cta_label: ctx.v5
      ? pick(ctx, "opening.cta", REVAMP_NEUTRAL_COPY.openingCta)
      : "Shop now",
    cta_href: "/shop",
    image_url: "",
    video_url: "",
    badge_text: "",
    background: "",
    theme: ctx.v5 ? pick(ctx, "opening.theme", TEXT_THEMES) : "light",
    alignment: ctx.v5
      ? pick(ctx, "opening.alignment", ["left", "center"])
      : "left",
  };
  config.image_url = autoShotRef(ctx, pageSlug, "hero", config, ["image_url"]);
  const validated = validateConfig("hero", config, "publish");
  return {
    id: ctx.newId(),
    type: "hero",
    enabled: true,
    config:
      "config" in validated
        ? validated.config
        : (config as unknown as PageSectionItem["config"]),
    style: { width: "full" },
  };
}

// ---------------------------------------------------------------------------
// Pages.
// ---------------------------------------------------------------------------

function readModelPages(
  ctx: Ctx,
  raw: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  pages.forEach((page, i) => {
    if (!isRecord(page)) return;
    const slug = normalizeRevampPageSlug(page.slug);
    if (out.has(slug)) {
      issue(
        ctx,
        `pages[${i}]: the page "${pageLabel(slug)}" appears twice; write each page once.`,
        null,
      );
      return;
    }
    out.set(slug, page);
  });
  return out;
}

function pageText(
  ctx: Ctx,
  page: WorkingPage,
  raw: Record<string, unknown>,
): void {
  const where = `Page "${page.label}"`;
  const existing = page.snapshotPage;
  const fallbackTitle =
    page.slug === ""
      ? ctx.snapshot.storeName
      : existing?.title ||
        page.slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  let title = clipText(
    checkCopy(ctx, text(raw.title), `${where} title`),
    REVAMP_TEXT_LIMITS.pageTitle,
  );
  if (!title) {
    issue(ctx, `${where} needs a title.`, "page");
    title = clipText(fallbackTitle, REVAMP_TEXT_LIMITS.pageTitle);
  }
  const seoTitle =
    clipText(
      checkCopy(ctx, text(raw.seoTitle), `${where} seoTitle`),
      REVAMP_TEXT_LIMITS.seoTitle,
    ) || clipText(title, REVAMP_TEXT_LIMITS.seoTitle);
  let seoDescription = clipText(
    checkCopy(ctx, text(raw.seoDescription), `${where} seoDescription`),
    REVAMP_TEXT_LIMITS.seoDescription,
  );
  if (seoDescription.length < REVAMP_TEXT_LIMITS.seoDescriptionMin) {
    issue(
      ctx,
      `${where} seoDescription must be at least ${REVAMP_TEXT_LIMITS.seoDescriptionMin} characters: one plain sentence about the page.`,
      "page",
    );
    seoDescription = fallbackSeoDescription(
      title,
      ctx.snapshot.storeName,
      ctx.v5 ? `${ctx.seed}|seo|${page.label}` : undefined,
    );
  }
  page.title = title;
  page.seoTitle = seoTitle;
  page.seoDescription = seoDescription;
}

/**
 * A page's search description when the plan's was too short. With a `seed`
 * (a v5 plan) its closing line is picked for the store from
 * `REVAMP_NEUTRAL_COPY.seoTail`; without one (the checks, a v4 plan) it is
 * the line it always was.
 */
export function fallbackSeoDescription(
  title: string,
  storeName: string,
  seed?: string,
): string {
  const tail = seed
    ? revampSeededPick(seed, REVAMP_NEUTRAL_COPY.seoTail)
    : "Browse the shop and find out more.";
  const base =
    title.trim().toLowerCase() === storeName.trim().toLowerCase()
      ? `${storeName}. ${tail}`
      : `${title} - ${storeName}. ${tail}`;
  return clipText(base, REVAMP_TEXT_LIMITS.seoDescription);
}

function buildModelPage(
  ctx: Ctx,
  page: WorkingPage,
  raw: Record<string, unknown>,
): void {
  pageText(ctx, page, raw);
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  const merchant = new Map(
    merchantSectionsOf(page.snapshotPage).map((s) => [s.id, s]),
  );
  const keptIds = new Set<string>();
  rawSections.forEach((rawSection, i) => {
    const index = i + 1;
    if (!isRecord(rawSection)) {
      issue(
        ctx,
        `Page "${page.label}" section ${index} is not an object.`,
        "section",
      );
      return;
    }
    const keep = text(rawSection.keep).trim();
    if (keep) {
      const own = merchant.get(keep);
      if (!own) {
        const theme = page.snapshotPage?.sections.some((s) => s.id === keep);
        issue(
          ctx,
          theme
            ? `Page "${page.label}" section ${index} keeps "${keep}", a section the theme or an earlier Mink run wrote; write a new section in its place instead (only the merchant's own sections are kept).`
            : `Page "${page.label}" section ${index} keeps "${keep}", which is not one of the merchant's own sections on this page.`,
          "section",
        );
        return;
      }
      if (keptIds.has(keep)) return;
      keptIds.add(keep);
      page.sections.push({
        item: keepMerchantSection(ctx, page.slug, own),
        kept: true,
        index,
      });
      return;
    }
    const built = buildNewSection(ctx, page, index, rawSection);
    if (built) page.sections.push(built);
  });
}

function applyPageRules(ctx: Ctx, page: WorkingPage): void {
  ensureMerchantSections(ctx, page);
  const isHome = page.slug === "";
  if (isHome) enforceOpening(ctx, page);
  enforceNewsletter(ctx, page);
  enforceSchemes(page, isHome);
  if (isHome && !page.copied && enabledSections(page).length < 4) {
    strictOnly(
      ctx,
      // ★ v5 names no one order of sections: the prompt offers three.
      ctx.v5
        ? `The homepage has ${enabledSections(page).length} sections; give it at least four, the opening among them, chosen for the business from the structures in <industry_playbook>.`
        : `The homepage has ${enabledSections(page).length} sections; give it at least four, chosen for the business (value points, products, categories, a story, questions, a newsletter).`,
    );
  }
  if (page.sections.length > MAX_PAGE_SECTIONS) {
    pageIssue(
      ctx,
      page,
      `Page "${page.label}" has ${page.sections.length} sections; a page holds at most ${MAX_PAGE_SECTIONS}.`,
      "section",
    );
    const keep: WorkingSection[] = [];
    let room = MAX_PAGE_SECTIONS - page.sections.filter((s) => s.kept).length;
    for (const s of page.sections) {
      if (s.kept) keep.push(s);
      else if (room > 0) {
        keep.push(s);
        room -= 1;
      }
    }
    page.sections = keep;
  }
  ensureUniqueSectionIds(ctx, page);
}

/**
 * ★ Section ids are unique on a page. A merchant's id never changes, so a new
 * section that collides with one (or with another new one) gets another id.
 */
function ensureUniqueSectionIds(ctx: Ctx, page: WorkingPage): void {
  const seen = new Set(
    page.sections.filter((s) => s.kept).map((s) => s.item.id),
  );
  for (const s of page.sections) {
    if (s.kept) continue;
    let id = s.item.id;
    for (let n = 1; !id || seen.has(id); n++) {
      id = n <= 3 ? ctx.newId() : `${s.item.id || "section"}-${n}`;
    }
    s.item.id = id;
    seen.add(id);
  }
}

/** A page copied from the previous plan, re-resolved against the store now. */
function copyPreviousPage(
  ctx: Ctx,
  previous: RevampPlannedPage,
  snapshotPage: RevampSnapshotPage | null,
): WorkingPage {
  const page: WorkingPage = {
    slug: previous.slug,
    label: pageLabel(previous.slug),
    title: previous.title,
    seoTitle: previous.seoTitle,
    seoDescription: previous.seoDescription,
    create: !snapshotPage,
    pageId: snapshotPage?.id ?? null,
    snapshotPage,
    sections: [],
    copied: true,
  };
  const merchant = new Map(
    merchantSectionsOf(snapshotPage).map((s) => [s.id, s]),
  );
  previous.sections.forEach((section, i) => {
    // ★ A section the merchant has edited since is theirs now: their words win.
    const own = merchant.get(section.id);
    const item = own
      ? keepMerchantSection(ctx, page.slug, own)
      : relinkCopied(ctx, clone(section));
    page.sections.push({ item, kept: !!own, index: i + 1 });
  });
  return page;
}

/** A copied section whose links no longer reach anything loses them, quietly. */
function relinkCopied(ctx: Ctx, section: PageSectionItem): PageSectionItem {
  for (const leaf of stringLeaves(section.config)) {
    const key = lastKey(leaf.path);
    if (isLinkKey(key)) {
      const ok = checkRevampLink(leaf.value, ctx.targets);
      setAt(section.config, leaf.path, ok ?? "");
      if (ok === null && key === "cta_href") {
        setAt(section.config, [...leaf.path.slice(0, -1), "cta_label"], "");
      }
    } else if (section.type === "rich_text" && key === "html") {
      setAt(
        section.config,
        leaf.path,
        sanitizeRichText(
          leaf.value,
          (href) => checkRevampLink(href, ctx.targets) || null,
          () => {},
        ),
      );
    } else if (isImageKey(key)) {
      // ★ A photo the store no longer owns (removed, broken) is cleared; a
      //   shot and an owned photo stay.
      const value = leaf.value.trim();
      if (value && slotIdOf(value) === null && !ctx.owned.has(value)) {
        setAt(section.config, leaf.path, "");
      }
    }
  }
  return section;
}

// ---------------------------------------------------------------------------
// Menus, chrome copy, design.
// ---------------------------------------------------------------------------

/**
 * ★ A MENU LINK LABELLED HOME GOES TO "/" (B19). "Home" (any case, also
 *   "Home page" or "Homepage") means the homepage, so its address is set,
 *   not judged: a model that wrote "/home" (a page no store has) used to lose
 *   the link to the dead-link rule, and one that wrote "/shop" sent shoppers
 *   to the wrong place under the right word. ★★ Unless it goes to a
 *   category, product or page of the store's own called Home
 *   (`homeNamedLinks`): a lifestyle shop's Women, Men and Home categories
 *   keep their Home.
 */
export function isHomeLabel(label: string): boolean {
  return /^home(?:\s*page)?$/i.test(label.trim());
}

/** Where a menu link labelled `label` and written as `rawHref` goes. */
function menuLinkHref(ctx: Ctx, label: string, rawHref: string): string | null {
  const checked = checkRevampLink(rawHref, ctx.targets);
  if (!isHomeLabel(label)) return checked;
  return checked && ctx.homeNamed.has(checked) ? checked : "/";
}

/**
 * ★★ The links whose own target is called Home (B19): a category or product
 * named Home, or at the address "home", and a page titled Home, each one
 * that will exist after Apply (`checkRevampLink`). Under the label Home such
 * a link is the store's own, so it is kept; any other link labelled Home goes
 * to "/". A theme sample is never one: it is not a link target.
 */
function homeNamedLinks(ctx: Ctx, pages: readonly WorkingPage[]): Set<string> {
  const out = new Set<string>();
  const named = (value: string | null | undefined) => isHomeLabel(value ?? "");
  const offer = (href: string, home: boolean) => {
    if (!home) return;
    const checked = checkRevampLink(href, ctx.targets);
    if (checked && checked !== "/") out.add(checked);
  };
  for (const category of ctx.snapshot.categories) {
    const renamed = ctx.request.categories.find(
      (change) => change.action === "update" && change.slug === category.slug,
    );
    const name =
      renamed?.action === "update" && renamed.name
        ? renamed.name
        : category.name;
    offer(
      `/collections/${category.slug}`,
      category.slug === "home" || named(name),
    );
  }
  for (const change of ctx.request.categories) {
    if (change.action !== "create") continue;
    const slug = createdCategorySlug(change);
    if (slug)
      offer(`/collections/${slug}`, slug === "home" || named(change.name));
  }
  for (const product of ctx.snapshot.products) {
    offer(
      `/shop/${product.slug}`,
      product.slug === "home" || named(product.name),
    );
  }
  const newSlugs = revampNewProductSlugs(ctx);
  for (const product of ctx.request.products) {
    const slug = newSlugs.get(product.key);
    if (slug) offer(`/shop/${slug}`, slug === "home" || named(product.name));
  }
  for (const page of ctx.snapshot.pages) {
    if (page.slug) offer(`/${page.slug}`, named(page.title));
  }
  for (const page of pages) {
    if (page.slug) offer(`/${page.slug}`, named(page.title));
  }
  return out;
}

function buildHeader(ctx: Ctx, raw: unknown, copied: boolean): NavLink[] {
  const items = Array.isArray(raw) ? raw : [];
  const quiet = copied;
  const level = (list: unknown, depth: number, where: string): NavLink[] => {
    const out: NavLink[] = [];
    (Array.isArray(list) ? list : []).forEach((item, i) => {
      if (!isRecord(item)) return;
      const at = `${where}[${i}]`;
      const label = clipText(
        checkCopy(ctx, text(item.label), `${at} label`, quiet),
        NAV_LIMITS.label,
      );
      if (!label) return;
      const children =
        depth < 2 ? level(item.children, depth + 1, `${at}.children`) : [];
      const rawHref = text(item.href);
      // ★ A link labelled Home goes home (B19), silently, unless it goes to
      //   the store's own category, product or page called Home.
      let href = menuLinkHref(ctx, label, rawHref);
      if (href === null) {
        if (!quiet) {
          issue(
            ctx,
            `${at} "${label}" links to "${clipText(rawHref, 80)}", which will not exist after Apply. ${LINK_HELP}`,
            "link",
          );
        }
        href = "";
      }
      if (!href && children.length === 0) return;
      out.push(children.length ? { label, href, children } : { label, href });
    });
    return out;
  };
  let header = level(items, 0, "menus.header");
  if (header.length > REVAMP_MAX_HEADER_LINKS) {
    if (!quiet) {
      issue(
        ctx,
        `menus.header has ${header.length} top-level links; use at most ${REVAMP_MAX_HEADER_LINKS} (put the rest under a menu's children or in the footer).`,
        "menu",
      );
    }
    header = header.slice(0, REVAMP_MAX_HEADER_LINKS);
  }
  if (header.length === 0) {
    if (!quiet) {
      issue(
        ctx,
        `menus.header is empty; give the header at least a "Shop" link to "/shop".`,
        "menu",
      );
    }
    // ★ v5: the one link's label is picked for the store.
    header = [
      {
        label: ctx.v5
          ? pick(ctx, "header.shop", REVAMP_NEUTRAL_COPY.shopLink)
          : "Shop",
        href: "/shop",
      },
    ];
  }
  return cleanNavTree(header);
}

function buildFooter(ctx: Ctx, raw: unknown, copied: boolean): FooterGroup[] {
  const groups = Array.isArray(raw) ? raw : [];
  const out: FooterGroup[] = [];
  groups.forEach((group, i) => {
    if (!isRecord(group) || out.length >= 6) return;
    const where = `menus.footerGroups[${i}]`;
    const title = clipText(
      checkCopy(ctx, text(group.title), `${where} title`, copied),
      NAV_LIMITS.label,
    );
    const links: NavLink[] = [];
    (Array.isArray(group.links) ? group.links : []).forEach((link, j) => {
      if (!isRecord(link) || links.length >= 12) return;
      const at = `${where}.links[${j}]`;
      const label = clipText(
        checkCopy(ctx, text(link.label), `${at} label`, copied),
        NAV_LIMITS.label,
      );
      const rawHref = text(link.href);
      // ★ A link labelled Home goes home (B19), silently, unless it goes to
      //   the store's own category, product or page called Home.
      const href = menuLinkHref(ctx, label, rawHref);
      if (!label) return;
      if (!href) {
        if (href === null && !copied) {
          issue(
            ctx,
            `${at} "${label}" links to "${clipText(rawHref, 80)}", which will not exist after Apply. ${LINK_HELP}`,
            "link",
          );
        }
        return;
      }
      links.push({ label, href });
    });
    if (!title && links.length === 0) return;
    out.push({ title, links });
  });
  return out;
}

function chromeText(
  ctx: Ctx,
  raw: unknown,
  key: string,
  where: string,
  max: number,
  fallback: () => string,
  copied: boolean,
): string {
  const value = clipText(checkCopy(ctx, text(raw), where, copied), max);
  if (value) return value;
  if (!copied) {
    issue(
      ctx,
      `${where} is empty; write it from the merchant's facts.`,
      "copy",
    );
  }
  return (
    clipText(checkCopy(ctx, fallback(), where, true), max) || clipText(key, max)
  );
}

function briefLine(ctx: Ctx, max: number): string {
  return clipText(checkCopy(ctx, ctx.request.brief.business, "", true), max);
}

interface DesignResult {
  design: StorefrontDesignOverrides;
  fontPairing: string | null;
}

/** The theme's own colours, as fallbacks for the contrast check. */
function themeFallbackPalette(
  snapshot: RevampSnapshot,
): Partial<Record<DesignPaletteToken, string>> {
  const p = snapshot.theme.palette;
  const out: Partial<Record<DesignPaletteToken, string>> = {};
  const set = (token: DesignPaletteToken, value: string) => {
    const hex = normalizeRevampHex(value);
    if (hex) out[token] = hex;
  };
  set("cream", p.page);
  set("surface", p.surface);
  set("ink", p.ink);
  set("accent", p.accent);
  return out;
}

/** Extra legibility pairs the storefront renders on every page. */
function extraContrastIssues(
  palette: Partial<Record<DesignPaletteToken, string>>,
): string[] {
  const pairs: Array<[DesignPaletteToken, DesignPaletteToken, string]> = [
    ["inkSoft", "surface", "muted text on cards"],
    ["ink", "creamDeep", "text on the footer and soft bands"],
    ["inkSoft", "creamDeep", "muted text on the footer and soft bands"],
  ];
  const out: string[] = [];
  for (const [fg, bg, label] of pairs) {
    const a = palette[fg];
    const b = palette[bg];
    if (!a || !b) continue;
    const ratio = contrastRatio(a, b);
    if (ratio < 4.5) {
      out.push(
        `${label} is hard to read (contrast ${ratio.toFixed(1)}:1, needs 4.5:1).`,
      );
    }
  }
  return out;
}

/** Soft and tint bands carry body text in ink: it must read on them. */
function schemeContrastProblems(
  palette: Partial<Record<DesignPaletteToken, string>>,
  used: ReadonlySet<SectionScheme>,
): string[] {
  const ink = palette.ink;
  const cream = palette.cream;
  if (!ink || !cream) return [];
  const out: string[] = [];
  const check = (scheme: SectionScheme, background: string | undefined) => {
    if (!background || !used.has(scheme)) return;
    const soft = mixHex(ink, background, SCHEME_MIX.textSoft);
    if (
      schemeContrast(ink, background) < 4.5 ||
      schemeContrast(soft, background) < 4.5
    ) {
      out.push(
        `text in the "${scheme}" colour band is hard to read; choose colours with more contrast or another scheme.`,
      );
    }
  };
  check("soft", palette.creamDeep);
  if (palette.accent)
    check("tint", mixHex(palette.accent, cream, SCHEME_MIX.tint));
  return out;
}

/**
 * Every readability rule a revamp's palette is held to, as today's
 * sentences: the storefront's three pairs (contrastIssuesFor, the theme's
 * colours standing in for any left out), the extra pairs, the colour bands
 * the plan uses, and the page's polarity. ★ The one judge of a palette: the
 * model's, and a mended one before it is kept.
 */
function paletteProblems(
  palette: Partial<Record<DesignPaletteToken, string>>,
  fallback: Partial<Record<DesignPaletteToken, string>>,
  usedSchemes: ReadonlySet<SectionScheme>,
): string[] {
  const problems = [
    ...contrastIssuesFor(
      { palette, fonts: { body: null, display: null }, shape: {} },
      { palette: fallback },
    ),
    ...extraContrastIssues(palette),
    ...schemeContrastProblems(palette, usedSchemes),
  ];
  const themePage = fallback.cream;
  if (
    themePage &&
    palette.cream &&
    isLightColour(themePage) !== isLightColour(palette.cream)
  ) {
    problems.push(
      `the page colour turns the theme from ${isLightColour(themePage) ? "light" : "dark"} to ${isLightColour(themePage) ? "dark" : "light"}; keep a ${isLightColour(themePage) ? "light" : "dark"} page (the theme's buttons and badges are made for it).`,
    );
  }
  return problems;
}

/** The colours the theme's snapshot carries (themeFallbackPalette). */
const THEME_KNOWN_TOKENS: readonly DesignPaletteToken[] = [
  "cream",
  "surface",
  "ink",
  "accent",
];

/**
 * A colour worked out from the page and text colours, with the weights the
 * storefront's own colour bands use (homepage.css, SCHEME_MIX): a soft band
 * 6% text, muted text 76%, faint text 56%, hairlines 16%.
 */
const DERIVED_MIX: Partial<Record<DesignPaletteToken, number>> = {
  creamDeep: SCHEME_MIX.deep,
  inkSoft: SCHEME_MIX.textSoft,
  inkFaint: SCHEME_MIX.textFaint,
  border: SCHEME_MIX.border,
};

/** How far a mended colour moves toward its pole at each try (percent). */
const REPAIR_STEP = 5;

type TextToken = "ink" | "inkSoft";
type BackgroundRole = "cream" | "surface" | "creamDeep" | "tint";

/**
 * Which text colour fails on which background, pair by pair, for exactly
 * the pairs `paletteProblems` judges (the band rules included: a band's
 * muted text is its text mixed 76% into the band).
 */
function failingPairs(
  p: Partial<Record<DesignPaletteToken, string>>,
  usedSchemes: ReadonlySet<SectionScheme>,
): Array<{ text: TextToken; background: BackgroundRole }> {
  const out: Array<{ text: TextToken; background: BackgroundRole }> = [];
  const reads = (fg: string | undefined, bg: string | undefined) =>
    !fg || !bg || contrastRatio(fg, bg) >= DESIGN_MIN_CONTRAST;
  const band = (bg: string | undefined) =>
    !p.ink ||
    !bg ||
    (reads(p.ink, bg) && reads(mixHex(p.ink, bg, SCHEME_MIX.textSoft), bg));
  for (const token of ["ink", "inkSoft"] as const) {
    for (const background of ["cream", "surface", "creamDeep"] as const) {
      if (!reads(p[token], p[background])) {
        out.push({ text: token, background });
      }
    }
  }
  if (usedSchemes.has("soft") && !band(p.creamDeep)) {
    out.push({ text: "ink", background: "creamDeep" });
  }
  if (usedSchemes.has("tint") && p.accent && p.cream) {
    if (!band(mixHex(p.accent, p.cream, SCHEME_MIX.tint))) {
      out.push({ text: "ink", background: "tint" });
    }
  }
  return out;
}

/**
 * The least move of `from` toward `pole` (in REPAIR_STEP steps) that `ok`
 * accepts; the pole itself when no step does.
 */
function stepToward(
  from: string,
  pole: string,
  ok: (candidate: string) => boolean,
): string {
  for (let weight = REPAIR_STEP; weight < 100; weight += REPAIR_STEP) {
    const candidate = mixHex(pole, from, weight);
    if (ok(candidate)) return candidate;
  }
  return pole;
}

/**
 * ★★ ONE BAD COLOUR NO LONGER COSTS ALL EIGHT (B18). A palette that fails is
 * mended colour by colour, and every colour that did not fail is kept:
 *   1. A page that would flip light to dark (or back) keeps the theme's page
 *      layer; the accent stays when its tinted band still reads.
 *   2. A colour that is not a colour: a page, card, text or accent colour
 *      follows the theme's; a soft band, muted text, faint text or hairline
 *      is worked out from the page and text colours (DERIVED_MIX).
 *   3. Text that does not read is moved toward black on a light page (white
 *      on a dark one), the least that reads on every background it sits on.
 *   4. A background even the pole cannot read on is moved toward white on a
 *      light page (black on a dark one); a tinted band that cannot be made
 *      to read gives up the new accent.
 * ★ THE RULES ARE NOT RELAXED. The mended palette must pass
 *   `paletteProblems`, today's rules exactly, on the colours the storefront
 *   will show (the theme's standing in for any left out), or the whole
 *   palette is dropped as before ("theme").
 */
export function repairRevampPalette(
  proposed: Partial<Record<DesignPaletteToken, string>>,
  fallback: Partial<Record<DesignPaletteToken, string>>,
  usedSchemes: ReadonlySet<SectionScheme>,
): {
  palette: Partial<Record<DesignPaletteToken, string>>;
  outcome: "repaired" | "polarity" | "theme";
} {
  const passes = (palette: Partial<Record<DesignPaletteToken, string>>) =>
    paletteProblems({ ...fallback, ...palette }, fallback, usedSchemes)
      .length === 0;

  // 1. Polarity: the theme's page layer, the accent alone may stay.
  const themePage = fallback.cream;
  if (
    themePage &&
    proposed.cream &&
    isLightColour(themePage) !== isLightColour(proposed.cream)
  ) {
    const accentOnly = proposed.accent ? { accent: proposed.accent } : {};
    return proposed.accent && passes(accentOnly)
      ? { palette: accentOnly, outcome: "polarity" }
      : { palette: {}, outcome: "theme" };
  }

  // 2. Every colour the storefront will show: the model's, else the theme's
  //    (cream, surface, ink, accent), else worked out (the rest) from a page
  //    or text colour that is new. ★ With neither new, the theme's own soft
  //    band, muted text, faint text and hairlines are the right ones and are
  //    left to it.
  const p: Partial<Record<DesignPaletteToken, string>> = {};
  for (const token of THEME_KNOWN_TOKENS) {
    const value = proposed[token] ?? fallback[token];
    if (value) p[token] = value;
  }
  const newPage = proposed.ink !== undefined || proposed.cream !== undefined;
  for (const token of DESIGN_PALETTE_TOKENS) {
    if (THEME_KNOWN_TOKENS.includes(token)) continue;
    const mix = DERIVED_MIX[token];
    const value =
      proposed[token] ??
      (newPage && mix !== undefined && p.ink && p.cream
        ? mixHex(p.ink, p.cream, mix)
        : undefined);
    if (value) p[token] = value;
  }

  const lightPage = p.cream ? isLightColour(p.cream) : true;
  const textPole = lightPage ? "#000000" : "#ffffff";
  const backgroundPole = lightPage ? "#ffffff" : "#000000";
  const original = { ...p };

  // 3. Text first: the least move that reads everywhere it sits.
  const mendText = () => {
    for (const token of ["ink", "inkSoft"] as const) {
      const from = original[token];
      if (!from) continue;
      p[token] = from;
      const fails = (palette: Partial<Record<DesignPaletteToken, string>>) =>
        failingPairs(palette, usedSchemes).some((f) => f.text === token);
      if (!fails(p)) continue;
      p[token] = stepToward(
        from,
        textPole,
        (candidate) => !fails({ ...p, [token]: candidate }),
      );
    }
  };
  mendText();

  // 4. A background even the pole cannot read on.
  let left = failingPairs(p, usedSchemes);
  if (left.length > 0) {
    const atPole = { ...p, ink: textPole, inkSoft: textPole };
    for (const background of ["cream", "surface", "creamDeep"] as const) {
      const from = p[background];
      if (!from || !left.some((f) => f.background === background)) continue;
      const readsAtPole = (candidate: string) =>
        !failingPairs({ ...atPole, [background]: candidate }, usedSchemes).some(
          (f) => f.background === background,
        );
      if (readsAtPole(from)) continue;
      p[background] = stepToward(from, backgroundPole, readsAtPole);
      atPole[background] = p[background];
    }
    if (failingPairs(p, usedSchemes).some((f) => f.background === "tint")) {
      // ★ The accent is the brand's colour: it is given up, never repainted.
      if (fallback.accent) p.accent = fallback.accent;
      else delete p.accent;
    }
    mendText();
    left = failingPairs(p, usedSchemes);
  }

  // Only the new look is written: a colour that went back to the theme's
  // (an unusable one, a given-up accent) is left to the theme, so a later
  // theme release still reaches it.
  const palette: Partial<Record<DesignPaletteToken, string>> = {};
  for (const token of DESIGN_PALETTE_TOKENS) {
    const value = p[token];
    if (!value) continue;
    if (
      THEME_KNOWN_TOKENS.includes(token) &&
      value === fallback[token] &&
      proposed[token] !== value
    ) {
      continue;
    }
    palette[token] = value;
  }
  if (
    left.length > 0 ||
    Object.keys(palette).length === 0 ||
    !passes(palette)
  ) {
    return { palette: {}, outcome: "theme" };
  }
  return { palette, outcome: "repaired" };
}

function buildDesign(
  ctx: Ctx,
  raw: unknown,
  usedSchemes: ReadonlySet<SectionScheme>,
  /** The plan's design direction, when it has one (the page is fitted to it, v5). */
  direction: string | null,
): DesignResult {
  const d = isRecord(raw) ? raw : {};
  const rawPalette = isRecord(d.palette) ? d.palette : {};
  const proposed: Partial<Record<DesignPaletteToken, string>> = {};
  const bad: DesignPaletteToken[] = [];
  for (const token of DESIGN_PALETTE_TOKENS) {
    const hex = normalizeRevampHex(rawPalette[token]);
    if (hex) proposed[token] = hex;
    else bad.push(token);
  }
  const fallback = themeFallbackPalette(ctx.snapshot);
  // ★ The sentences the model reads are today's: an unusable colour is named,
  //   and only a palette of eight usable colours is judged for readability.
  const problems = bad.length
    ? []
    : paletteProblems({ ...fallback, ...proposed }, fallback, usedSchemes);
  let palette = proposed;
  /** False once the theme's page was kept over the new one (B18's outcomes). */
  let newPage = true;
  if (bad.length || problems.length) {
    // ★★ ONE BAD COLOUR NO LONGER COSTS ALL EIGHT (B18). Only the colour
    //    that fails is mended; the rest of the merchant's new look stays.
    const repair = repairRevampPalette(proposed, fallback, usedSchemes);
    palette = repair.palette;
    newPage = repair.outcome === "repaired";
    const fix: FixKind =
      repair.outcome === "theme"
        ? "paletteKept"
        : repair.outcome === "polarity"
          ? "polarity"
          : bad.length
            ? "colour"
            : "palette";
    if (bad.length) {
      issue(
        ctx,
        `design.palette ${bad.join(", ")} must each be a colour written as #rrggbb.`,
        fix,
      );
    }
    if (problems.length) {
      issue(ctx, `design.palette: ${problems.join(" ")}`, fix);
    }
  }
  // ★★ v5: the page colour suits the direction the plan chose, by Theme
  //    Studio's rule; only the page colour moves (palette honesty, step 3).
  //    ★ Not where B18 kept the theme's page (the card says it was kept).
  //    ★★ Never a page colour the merchant asked for: not in a refinement
  //    (its instruction decides the colours), and not when their words name
  //    a page colour (review fix, 25 Oct).
  if (
    ctx.v5 &&
    direction &&
    newPage &&
    ctx.request.kind === "full" &&
    !revampMerchantNamesPage(ctx.request)
  ) {
    palette = fitRevampPageToDirection(
      palette,
      fallback,
      direction,
      usedSchemes,
    ).palette;
  }
  const pairing = isFontPairingKey(d.fontPairing) ? d.fontPairing : null;
  if (!pairing) {
    issue(
      ctx,
      `design.fontPairing "${clipText(text(d.fontPairing), 40)}" is not one of the pairings in <font_pairings>.`,
      "fonts",
    );
  }
  const rawRadii = isRecord(d.radii) ? d.radii : {};
  const shape: Partial<Record<DesignShapeKey, number>> = {};
  for (const key of DESIGN_SHAPE_KEYS) {
    const value = rawRadii[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const max = key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX;
    shape[key] = Math.min(max, Math.max(0, Math.round(value)));
  }
  return {
    design: {
      palette,
      fonts: pairing
        ? {
            body: FONT_PAIRINGS[pairing].body,
            display: FONT_PAIRINGS[pairing].display,
          }
        : { body: null, display: null },
      shape,
    },
    fontPairing: pairing,
  };
}

/**
 * ★★ A DIRECTION PICKED FOR THE STORE (v5) when the answer gave none: among
 * the directions whose palettes the page colour suits (so the label never
 * contradicts the colours), the ones made for the store's industry first.
 */
function fallbackDirection(
  ctx: Ctx,
  page: string | undefined,
  industry: ThemeIndustry,
): DesignDirection {
  const fitting = page
    ? DESIGN_DIRECTION_IDS.filter((id) => revampPageFitsDirection(id, page))
    : [...DESIGN_DIRECTION_IDS];
  const suited = fitting.filter((id) =>
    (DESIGN_DIRECTIONS[id].industries as readonly string[]).includes(industry),
  );
  const pool = suited.length
    ? suited
    : fitting.length
      ? fitting
      : DESIGN_DIRECTION_IDS;
  return pick(ctx, "direction", pool);
}

function buildAppearance(raw: unknown): RevampSitePlan["appearance"] {
  const a = isRecord(raw) ? raw : {};
  const out: RevampSitePlan["appearance"] = {};
  const pick = <K extends keyof typeof REVAMP_APPEARANCE_VARIANTS>(key: K) => {
    const value = a[key];
    return (REVAMP_APPEARANCE_VARIANTS[key] as readonly unknown[]).includes(
      value,
    )
      ? value
      : null;
  };
  const header = pick("header");
  if (header) out.header = header as StorefrontAppearance["header"];
  const card = pick("card");
  if (card) out.card = card as StorefrontAppearance["card"];
  const productDetail = pick("productDetail");
  if (productDetail)
    out.productDetail = productDetail as StorefrontAppearance["productDetail"];
  const footer = pick("footer");
  if (footer) out.footer = footer as StorefrontAppearance["footer"];
  return out;
}

// ---------------------------------------------------------------------------
// Shots and bindings.
// ---------------------------------------------------------------------------

function readModelShots(ctx: Ctx, raw: Record<string, unknown>): void {
  const shots = Array.isArray(raw.shots) ? raw.shots : [];
  shots.forEach((shot, i) => {
    if (!isRecord(shot)) return;
    const rawId = text(shot.id).trim();
    const id = sanitizeShotId(rawId);
    if (!id) {
      issue(
        ctx,
        `shots[${i}] has no usable id; give every shot a short id of lowercase letters, digits and hyphens.`,
        "photo",
      );
      return;
    }
    if (id !== rawId) {
      issue(
        ctx,
        `shots[${i}] id "${clipText(rawId, 40)}" is not a valid shot id; write it as "${id}" here and in every ${REVAMP_SLOT_PREFIX} that names it.`,
        "photo",
      );
    }
    if (ctx.modelShots.has(id)) {
      issue(
        ctx,
        `shots[${i}] repeats the id "${id}"; every shot has its own id.`,
        "photo",
      );
      return;
    }
    const purpose = (["hero", "content", "category"] as const).includes(
      shot.purpose as RevampShotPurpose,
    )
      ? (shot.purpose as RevampShotPurpose)
      : "content";
    ctx.modelShots.set(id, {
      id,
      purpose,
      subject: clipText(
        cleanRevampCopy(text(shot.subject)),
        REVAMP_TEXT_LIMITS.shotSubject,
      ),
      artDirection: clipText(
        cleanRevampCopy(text(shot.artDirection)),
        REVAMP_TEXT_LIMITS.artDirection,
      ),
      aspectRatio: text(shot.aspectRatio),
      people: shot.people === "adults" ? "adults" : "none",
      // ★ Read as written; `settleGoods` validates them once the shot's
      //   purpose and category are settled.
      goods:
        shot.goods === "merchant" || shot.goods === "none"
          ? shot.goods
          : undefined,
      productKeys: Array.isArray(shot.productKeys)
        ? shot.productKeys.map((key) => text(key))
        : [],
      category: sanitizeCategorySlug(shot.category),
      index: i,
    });
  });
}

function sanitizeCategorySlug(value: unknown): string | null {
  const s = text(value)
    .trim()
    .toLowerCase()
    .replace(/^\/?collections\//, "");
  return s ? s : null;
}

interface CollectedBinding {
  binding: RevampSlotBinding;
  page: WorkingPage | null;
  section: WorkingSection | null;
}

/** Every revamp-slot reference on the planned pages, as bindings. */
function collectBindings(pages: WorkingPage[]): CollectedBinding[] {
  const out: CollectedBinding[] = [];
  for (const page of pages) {
    for (const section of page.sections) {
      for (const leaf of stringLeaves(section.item.config)) {
        const rawId = slotIdOf(leaf.value);
        if (rawId === null) continue;
        const id = sanitizeShotId(rawId);
        const frameKey = revampFrameKeyFor(
          section.item.type,
          section.item.config,
          leaf.path,
        );
        if (!id || !frameKey) {
          setAt(section.item.config, leaf.path, "");
          continue;
        }
        if (id !== rawId) setAt(section.item.config, leaf.path, slotRef(id));
        const frame = frameOf(frameKey);
        let phonePath: Path | null = phonePathFor(
          section.item.type,
          leaf.path,
          frame.aspect,
        );
        if (phonePath && text(getAt(section.item.config, phonePath)).trim()) {
          // The merchant's own phone photo stays.
          phonePath = null;
        }
        out.push({
          binding: {
            shotId: id,
            pageSlug: page.slug,
            sectionId: section.item.id,
            path: leaf.path,
            frame,
            phonePath,
          },
          page,
          section,
        });
      }
    }
  }
  return out;
}

/** The shot the homepage's opening photograph is bound to, if any. */
function openingShotId(
  pages: WorkingPage[],
  bindings: CollectedBinding[],
): string | null {
  const home = pages.find((p) => p.slug === "");
  const first = home ? enabledSections(home)[0] : undefined;
  if (!first) return null;
  return bindings.find((b) => b.section === first)?.binding.shotId ?? null;
}

function defaultArtDirection(ctx: Ctx, direction: string): string {
  const look = clipText(cleanRevampCopy(ctx.request.brief.look), 200);
  const label =
    (DESIGN_DIRECTIONS as Record<string, { label: string }>)[direction]
      ?.label ?? "";
  return clipText(
    [
      // ★★ No light picked for the store (review fix, 25 Oct): a photo
      //   look varied across stores is step 9 of the audit (photo style
      //   choices), which waits for the owner's OK. The image model chooses
      //   the light, as it did before v5.
      "One photo shoot for the whole store: the same light, palette and setting in every picture",
      label ? `in a ${label.toLowerCase()} style` : "",
      look ? `with the look the merchant asked for: ${look}` : "",
    ]
      .filter(Boolean)
      .join(", ")
      .concat("."),
    REVAMP_TEXT_LIMITS.artDirection,
  );
}

/** A goods key as the model wrote it, to the key; null when it names none. */
function resolveGoodsKey(ctx: Ctx, raw: unknown): string | null {
  const value = text(raw).trim().toLowerCase();
  if (!value) return null;
  return (
    ctx.goodsAliases.get(value) ??
    ctx.goodsAliases.get(productNameKey(value)) ??
    null
  );
}

/** Up to two of a category's photographed products, in catalogue order. */
function categoryGoodsKeys(ctx: Ctx, slug: string): string[] {
  return [...ctx.goods.values()]
    .filter((item) => item.categorySlug === slug)
    .slice(0, REVAMP_SHOT_MAX_PRODUCT_KEYS)
    .map((item) => item.key);
}

/**
 * The compiler's own photograph of a category: the category's own
 * photographed products when it has any, else a scene with no products in
 * it, never goods nobody photographed (B16).
 */
function categoryAutoShot(
  ctx: Ctx,
  id: string,
  need: RevampCategoryPhotoNeed,
): RevampShot {
  const store = ctx.snapshot.storeName;
  const keys = categoryGoodsKeys(ctx, need.slug);
  const names = keys.map((key) => ctx.goods.get(key)?.name ?? "");
  return {
    id,
    purpose: "category",
    subject: clipText(
      keys.length > 0
        ? `${need.name} at ${store}: ${names.filter(Boolean).join(" and ")}`
        : `The ${need.name} category at ${store}, shown by its materials and setting, with no products in the picture`,
      REVAMP_TEXT_LIMITS.shotSubject,
    ),
    artDirection: "",
    aspectRatio: "1:1",
    people: "none",
    goods: keys.length > 0 ? "merchant" : "none",
    productKeys: keys,
  };
}

/**
 * ★★ REAL GOODS OR NO GOODS (B16). A shot's goods and productKeys, settled
 * against the merchant's photographed products (`revampGoodsCatalogue`):
 * a key that names no such product, or one without its own photo, is
 * dropped; a category shot keeps only its category's products; at most two
 * keys. A shot meant to show the merchant's goods with no key left becomes
 * a scene with no products ("none"), never invented goods, and the model is
 * asked to fix it (`reportable`). goods "none" carries no keys; goods left
 * out is read from the keys. Always fresh arrays: a shot split by shape
 * never shares its keys with its twin.
 * Returns true when the model asked for products the shot no longer shows,
 * so its words, which may name them, are written again (`buildShots`).
 */
function settleGoods(
  ctx: Ctx,
  shot: RevampShot,
  options: { category: string | null; reportable: boolean },
): boolean {
  const keys: string[] = [];
  const unknown: string[] = [];
  let offCategory = 0;
  for (const raw of Array.isArray(shot.productKeys) ? shot.productKeys : []) {
    const key = resolveGoodsKey(ctx, raw);
    if (!key) {
      const named = clipText(text(raw).trim(), 40);
      if (named) unknown.push(named);
      continue;
    }
    if (keys.includes(key)) continue;
    if (
      options.category !== null &&
      ctx.goods.get(key)?.categorySlug !== options.category
    ) {
      offCategory += 1;
      continue;
    }
    keys.push(key);
  }
  const wanted = shot.goods ?? (keys.length > 0 ? "merchant" : "none");
  if (wanted === "merchant" && keys.length > 0) {
    shot.goods = "merchant";
    shot.productKeys = keys.slice(0, REVAMP_SHOT_MAX_PRODUCT_KEYS);
    return (
      unknown.length > 0 ||
      offCategory > 0 ||
      keys.length > shot.productKeys.length
    );
  }
  shot.goods = "none";
  shot.productKeys = [];
  if (wanted !== "merchant") return false;
  if (!options.reportable) return true;
  const why = unknown.length
    ? ` (${unknown.map((k) => `"${k}"`).join(", ")} ${unknown.length === 1 ? "is not a product" : "are not products"} with its own photo)`
    : offCategory > 0
      ? ` (its products are not in the category ${options.category})`
      : "";
  issue(
    ctx,
    `shots "${shot.id}" has goods "merchant" but no usable productKeys${why}. Name one or two keys from <products> marked photo=yes${options.category !== null ? ` in the category ${options.category}` : ""}, or set goods "none" and describe a scene with no products in it.`,
    null,
  );
  return true;
}

/**
 * ★★ What a shot shows in the compiler's own words (B16): exactly the
 * products it names, or, with none, the store's own setting with no products
 * in the picture. For a shot with no subject, and for one whose own words may
 * name products it can no longer show: the compiler's (`settleGoods`) and the
 * photos step's (a product photo that cannot be read, `photos.ts`), so a
 * picture is never asked for a product and for none at once.
 */
export function revampShotSubjectFor(input: {
  storeName: string;
  /** The brief's line on what the store sells, as the merchant wrote it. */
  business: string;
  /** The names of the products the shot shows; none for a scene. */
  names: readonly string[];
  /** Where the shot is used, when the compiler knows (a kept section). */
  lead?: string;
}): string {
  const lead = input.lead ? `${input.lead}: ` : "";
  const names = input.names.map((name) => name.trim()).filter(Boolean);
  if (names.length > 0) {
    return clipText(
      `${lead}${names.join(" and ")}, photographed for ${input.storeName}`,
      REVAMP_TEXT_LIMITS.shotSubject,
    );
  }
  const business = clipText(cleanRevampCopy(input.business), 200);
  return clipText(
    `${lead}the setting behind ${input.storeName}${business ? ` (${business})` : ""}: its place, materials and light, with no products in the picture`,
    REVAMP_TEXT_LIMITS.shotSubject,
  );
}

/** What a shot shows when the model's words do not stand (`revampShotSubjectFor`). */
function defaultShotSubject(ctx: Ctx, id: string, shot: RevampShot): string {
  return revampShotSubjectFor({
    storeName: ctx.snapshot.storeName,
    business: briefLine(ctx, 200),
    names:
      shot.goods === "merchant"
        ? (shot.productKeys ?? []).map((key) => ctx.goods.get(key)?.name ?? "")
        : [],
    lead: ctx.refContext.get(id)?.context,
  });
}

interface ShotsResult {
  shots: RevampShot[];
  bindings: RevampSlotBinding[];
  /** Ids of `shots` a refinement carries over from its parent, in order. */
  carried: string[];
}

function buildShots(
  ctx: Ctx,
  pages: WorkingPage[],
  direction: string,
): ShotsResult {
  const previousShots = new Map(
    (ctx.previous?.shots ?? []).map((s) => [s.id, s]),
  );
  const collected = collectBindings(pages);

  // Category photographs: the model's, by category slug, else a new one.
  const needs = revampCategoryPhotoNeeds(ctx);
  const byCategory = new Map<string, string>();
  for (const shot of ctx.modelShots.values()) {
    if (shot.category && !byCategory.has(shot.category)) {
      byCategory.set(shot.category, shot.id);
    }
  }
  const categoryBindings: CollectedBinding[] = [];
  for (const need of needs) {
    const named = revampCategoryShotId(need.slug);
    // ★ The id the prompt gives a category's shot describes it, with or
    //   without the shot's `category` field.
    let id =
      byCategory.get(need.slug) ??
      (ctx.modelShots.has(named) ? named : undefined);
    if (!id) {
      const reuse = [...previousShots.values()].find(
        (s) =>
          s.purpose === "category" &&
          (ctx.previous?.bindings ?? []).some(
            (b) =>
              b.shotId === s.id &&
              b.pageSlug === "@category" &&
              b.sectionId === need.slug,
          ),
      );
      if (reuse) {
        id = reuse.id;
      } else {
        id = named;
        if (!ctx.boundedPhotos)
          issue(
            ctx,
            `shots: the category "${need.name}" (${need.slug}) gets a new photograph; describe a shot with purpose "category" and category "${need.slug}".`,
            "photo",
          );
        ctx.autoShots.set(id, categoryAutoShot(ctx, id, need));
      }
    }
    categoryBindings.push({
      binding: {
        shotId: id,
        pageSlug: "@category",
        sectionId: need.slug,
        path: ["image_url"],
        frame: REVAMP_CATEGORY_FRAME,
        phonePath: null,
      },
      page: null,
      section: null,
    });
  }
  const all = [...collected, ...categoryBindings];

  // Resolve every referenced id to a definition.
  const definitions = new Map<string, RevampShot>();
  /** A refinement's photographs carried over as they are (not redrawn). */
  const carried = new Set<string>();
  const resolve = (id: string, firstUse: CollectedBinding): void => {
    if (definitions.has(id)) return;
    const model = ctx.modelShots.get(id);
    const prior = previousShots.get(id);
    const redrawn = ctx.redraw === "all" || ctx.redraw.has(id);
    if (prior && (!model || !redrawn)) {
      // ★ A refinement keeps a photograph it was not asked to redraw: the
      //   parent's definition, so the photos step carries its picture over.
      definitions.set(id, { ...prior });
      if (!redrawn) carried.add(id);
      return;
    }
    if (model) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { category: _category, index: _index, ...shot } = model;
      definitions.set(id, shot);
      return;
    }
    const auto = ctx.autoShots.get(id);
    if (!auto) {
      const where = firstUse.page
        ? `Page "${firstUse.page.label}"${firstUse.section ? ` section ${firstUse.section.index} (${firstUse.section.item.type})` : ""}`
        : "A category photograph";
      issue(
        ctx,
        `${where} names ${REVAMP_SLOT_PREFIX}${id}, but no shot "${id}" is in shots. Describe it in shots or use another shot's id.`,
        "photo",
      );
    }
    definitions.set(id, {
      id,
      purpose: auto?.purpose ?? "content",
      subject: auto?.subject ?? "",
      artDirection: auto?.artDirection ?? "",
      aspectRatio: auto?.aspectRatio ?? "1:1",
      people: auto?.people ?? "none",
      goods: auto?.goods ?? "none",
      productKeys: [...(auto?.productKeys ?? [])],
    });
  };
  for (const c of all) resolve(c.binding.shotId, c);

  // Ids a split or a rename may not take: every shot anybody named.
  const taken = new Set<string>([
    ...definitions.keys(),
    ...previousShots.keys(),
    ...ctx.modelShots.keys(),
    ...ctx.autoShots.keys(),
  ]);
  const isTaken = (candidate: string): boolean => taken.has(candidate);
  const rebind = (use: CollectedBinding, id: string): void => {
    use.binding.shotId = id;
    if (use.section) {
      setAt(use.section.item.config, use.binding.path, slotRef(id));
    }
  };

  if (ctx.boundedPhotos) {
    const seenOnPage = new Set<string>();
    for (const use of all) {
      const id = use.binding.shotId;
      const key = `${id}|${use.binding.pageSlug}`;
      if (seenOnPage.has(key) && use.binding.pageSlug !== "@category") {
        const fresh = uniqueId(suffixedShotId(id, "distinct"), isTaken);
        taken.add(fresh);
        definitions.set(fresh, { ...definitions.get(id)!, id: fresh });
        rebind(use, fresh);
      } else seenOnPage.add(key);
    }
  }

  // ★ One shot, one shape: a shot bound to two shapes is split. The first
  //   shape keeps the id; every other shape gets ONE new id that all of its
  //   uses share.
  const byShot = new Map<string, CollectedBinding[]>();
  for (const c of all) {
    byShot.set(c.binding.shotId, [...(byShot.get(c.binding.shotId) ?? []), c]);
  }
  for (const [id, uses] of byShot) {
    const shapes: Array<{ aspect: number; id: string; aspects: number[] }> = [];
    for (const use of uses) {
      const aspect = use.binding.frame.aspect;
      const carriedShape = ctx.previous?.bindings.some(
        (binding) =>
          binding.shotId === id && sameShape(binding.frame.aspect, aspect),
      );
      let shape = shapes.find(
        (s) =>
          sameShape(s.aspect, aspect) ||
          ((ctx.boundedPhotos || carriedShape) &&
            Math.min(...s.aspects, aspect) / Math.max(...s.aspects, aspect) >=
              0.7),
      );
      if (!shape) {
        let shapeId = id;
        if (shapes.length > 0) {
          shapeId = uniqueId(
            suffixedShotId(id, String(shapes.length + 1)),
            isTaken,
          );
          taken.add(shapeId);
          definitions.set(shapeId, { ...definitions.get(id)!, id: shapeId });
        }
        shape = { aspect, id: shapeId, aspects: [aspect] };
        shapes.push(shape);
      }
      shape.aspects.push(aspect);
      if (shape.id !== id) rebind(use, shape.id);
    }
  }

  // Unused model shots cost a photo and show nowhere: dropped, quietly.
  const usedIds = new Set(all.map((c) => c.binding.shotId));
  for (const id of [...definitions.keys()]) {
    if (!usedIds.has(id)) definitions.delete(id);
  }

  // A refinement's shot that changed shape cannot reuse the parent's photo.
  for (const [id, shot] of [...definitions.entries()]) {
    const prior = previousShots.get(id);
    if (!prior) continue;
    const use = all.find((c) => c.binding.shotId === id);
    if (!use) continue;
    const priorAspect = aspectValue(prior.aspectRatio);
    const nowAspect = aspectValue(revampRatioFor(use.binding.frame.aspect));
    if (
      Number.isFinite(priorAspect) &&
      !sameShape(priorAspect, nowAspect) &&
      !(
        ctx.previous?.bindings.some(
          (binding) =>
            binding.shotId === id && sameShape(binding.frame.aspect, nowAspect),
        ) &&
        Math.min(priorAspect, nowAspect) / Math.max(priorAspect, nowAspect) >=
          0.7
      )
    ) {
      const fresh = uniqueId(suffixedShotId(id, "new"), isTaken);
      taken.add(fresh);
      definitions.delete(id);
      carried.delete(id);
      definitions.set(fresh, { ...shot, id: fresh });
      for (const c of all) if (c.binding.shotId === id) rebind(c, fresh);
    }
  }

  // ★ Read after the splits and renames, which can change an id.
  const opening = openingShotId(pages, collected);
  const categoryIds = new Set(categoryBindings.map((c) => c.binding.shotId));
  const categoryOf = new Map(
    categoryBindings.map((c) => [c.binding.shotId, c.binding.sectionId]),
  );

  // Ratio, purpose and people follow the slot, silently.
  for (const [id, shot] of definitions) {
    const use = all.find((c) => c.binding.shotId === id);
    if (use) shot.aspectRatio = revampRatioFor(use.binding.frame.aspect);
    if (categoryIds.has(id)) {
      shot.purpose = "category";
      shot.people = "none";
    } else if (id === opening) {
      shot.purpose = "hero";
    } else if (shot.purpose === "category") {
      shot.purpose = "content";
    }
    // ★★ Real goods or no goods (B16), once the purpose and the category
    //    are settled. Only the model's own shot is told about a problem; a
    //    carried, split or compiler-made one is settled quietly.
    const lost = settleGoods(ctx, shot, {
      category: categoryOf.get(id) ?? null,
      reportable: ctx.modelShots.has(id) && !carried.has(id),
    });
    // ★ A carried photograph is not drawn again: its words and people stay
    //   those of the picture they describe.
    const drawn = !carried.has(id);
    // ★★ A shot with no products has nobody in it: a person in a redesign
    //    photograph wears or uses a product (the planner's rule), and the
    //    image prompt's rule for people would otherwise ask for one.
    if (drawn && shot.goods === "none") shot.people = "none";
    if (!shot.subject) {
      if (ctx.modelShots.has(id)) {
        issue(
          ctx,
          `shots "${id}" has no subject; describe what the photograph shows.`,
          "photo",
        );
      }
      shot.subject = defaultShotSubject(ctx, id, shot);
    } else if (drawn && lost) {
      // ★★ The model's words may name a product the shot no longer shows: a
      //    picture asked for it beside the rule that it shows none (or only
      //    the others) invents it, or fails its check (B16).
      shot.subject = defaultShotSubject(ctx, id, shot);
    }
  }

  // ★ One art direction for the whole shoot. A refinement's carried-over
  //   photographs keep theirs (their pictures exist) and set it for the rest.
  const ordered = [...definitions.values()];
  const lead =
    ordered.find((s) => carried.has(s.id) && s.artDirection)?.artDirection ||
    (opening ? definitions.get(opening)?.artDirection : "") ||
    ordered.find((s) => ctx.modelShots.has(s.id) && s.artDirection)
      ?.artDirection ||
    ordered.find((s) => s.artDirection)?.artDirection ||
    "";
  if (!lead && ordered.length > 0 && ctx.modelShots.size > 0) {
    issue(
      ctx,
      `shots need an artDirection: one shared description of light, palette, setting and lens for the whole shoot.`,
      "photo",
    );
  }
  const artDirection = lead || defaultArtDirection(ctx, direction);
  for (const shot of ordered) {
    if (!carried.has(shot.id)) shot.artDirection = artDirection;
  }

  // The photo limit, the most visible first.
  limitShots(ctx, definitions, all, opening, categoryIds);

  // Sections a cleared photo left incomplete are dropped.
  for (const page of pages) {
    page.sections = page.sections.filter((s) => {
      if (s.kept) return true;
      const ok = validateConfig(s.item.type, s.item.config, "publish");
      if ("error" in ok) return false;
      s.item.config = ok.config;
      return true;
    });
  }

  const finalBindings = collectBindings(pages).map((c) => c.binding);
  for (const c of categoryBindings) {
    if (definitions.has(c.binding.shotId)) finalBindings.push(c.binding);
  }
  const liveIds = new Set(finalBindings.map((b) => b.shotId));
  const live = [...definitions.values()].filter((s) => liveIds.has(s.id));
  return {
    shots: live,
    bindings: finalBindings,
    carried: live.filter((s) => carried.has(s.id)).map((s) => s.id),
  };
}

/** `base` with `-suffix`, cut so the whole id stays within the id limit. */
function suffixedShotId(base: string, suffix: string): string {
  const head = base
    .slice(0, Math.max(0, SHOT_ID_MAX - suffix.length - 1))
    .replace(/-+$/g, "");
  return (
    sanitizeShotId(head ? `${head}-${suffix}` : suffix) ?? `shot-${suffix}`
  );
}

/**
 * The first of `base`, `base-2`, `base-3`… nobody has taken. ★ Each
 * candidate is cut BEFORE its suffix, so a long id can never be cut back to
 * one already taken (which looped for ever) or past the id limit.
 */
function uniqueId(base: string, isTaken: (id: string) => boolean): string {
  const clean = sanitizeShotId(base) ?? "shot";
  if (!isTaken(clean)) return clean;
  for (let n = 2; ; n++) {
    const candidate = suffixedShotId(clean, String(n));
    if (!isTaken(candidate)) return candidate;
  }
}

function limitShots(
  ctx: Ctx,
  definitions: Map<string, RevampShot>,
  all: CollectedBinding[],
  opening: string | null,
  categoryIds: ReadonlySet<string>,
): void {
  const max = ctx.boundedPhotos
    ? REVAMP_WORK_BUDGET.photos
    : REVAMP_LIMITS.maxShots;
  if (definitions.size <= max) return;
  if (!ctx.boundedPhotos)
    issue(
      ctx,
      `The plan describes ${definitions.size} photographs; a redesign draws at most ${max}. Reuse a shot where two slots can share one photograph, or use fewer image sections.`,
      "shots",
    );
  const firstHome = new Set(
    [
      ...new Set(
        all
          .filter((c) => c.binding.pageSlug === "")
          .map((c) => c.binding.shotId),
      ),
    ].slice(0, 3),
  );
  const rank = (id: string): number => {
    if (id === opening) return 0;
    if (ctx.boundedPhotos) {
      if (firstHome.has(id)) return 1;
      if (id.startsWith("refill-")) return 2;
      if (categoryIds.has(id)) return 3;
      if (all.some((c) => c.binding.shotId === id && c.binding.pageSlug === ""))
        return 4;
      return 5;
    }
    const use = all.find((c) => c.binding.shotId === id);
    if (categoryIds.has(id)) return ctx.boundedPhotos ? 1 : 2;
    if (use?.binding.pageSlug === "") return ctx.boundedPhotos ? 2 : 1;
    if (id.startsWith("refill-")) return 3;
    return 4;
  };
  const order = [...definitions.keys()].sort((a, b) => rank(a) - rank(b));
  const kept = new Set(order.slice(0, max));
  for (const id of order.slice(max)) {
    const removed = definitions.get(id)!;
    definitions.delete(id);
    let omitted = false;
    for (const c of all) {
      if (c.binding.shotId !== id) continue;
      // Another photograph of the same shape from the same shoot, else none.
      const twin = [...kept].find((k) => {
        const uses = all.filter((u) => u.binding.shotId === k);
        const use = uses[0];
        const aspects = [
          ...uses.map((u) => u.binding.frame.aspect),
          c.binding.frame.aspect,
        ];
        return (
          use &&
          (sameShape(use.binding.frame.aspect, c.binding.frame.aspect) ||
            (ctx.boundedPhotos &&
              Math.min(...aspects) / Math.max(...aspects) >= 0.7)) &&
          (!ctx.boundedPhotos ||
            (!categoryIds.has(id) &&
              !categoryIds.has(k) &&
              !all.some(
                (u) =>
                  u.binding.shotId === k &&
                  u.binding.pageSlug === c.binding.pageSlug,
              ) &&
              definitions.get(k)?.goods === removed.goods &&
              JSON.stringify(
                [...(definitions.get(k)?.productKeys ?? [])].sort(),
              ) === JSON.stringify([...(removed.productKeys ?? [])].sort())))
        );
      });
      if (!twin) omitted = true;
      if (c.section) {
        setAt(c.section.item.config, c.binding.path, twin ? slotRef(twin) : "");
      }
      c.binding.shotId = twin ?? "";
    }
    if (ctx.boundedPhotos && omitted) ctx.omittedPhotos += 1;
  }
}

// ---------------------------------------------------------------------------
// The whole plan.
// ---------------------------------------------------------------------------

interface BuildResult {
  plan: RevampSitePlan | null;
  issues: string[];
  fatal: string | null;
}

export interface RevampCompileOptions {
  /** New section ids; `crypto.randomUUID()` by default. */
  newId?: () => string;
}

/** What a plan is compiled against. */
export interface RevampCompileInput {
  request: RevampRequest;
  snapshot: RevampSnapshot;
  previous: RevampSitePlan | null;
  /**
   * ★ The redesign's own id, which seeds what a v5 answer left out together
   *   with the store's (`revampDesignSeed`), so a redo of the same store
   *   picks again. Absent, the store's id alone seeds it.
   */
  revampId?: string | null;
  /** Server-owned work policy, independent of the model's version claim. */
  photoBudget?: number;
}

function buildPlan(
  raw: unknown,
  input: RevampCompileInput,
  mode: Mode,
  options: RevampCompileOptions,
): BuildResult {
  const { request, snapshot } = input;
  const previous = request.kind === "refine" ? input.previous : null;
  if (!isRecord(raw)) {
    const sentence =
      "The answer was empty or not a JSON object. Return the whole site plan as one JSON object matching the schema.";
    return { plan: null, issues: [sentence], fatal: sentence };
  }

  const evidence = revampClaimEvidence(request, snapshot);
  const redrawScope = request.refineScope?.photos ?? null;
  const goods = revampGoodsCatalogue(input);
  const ctx: Ctx = {
    mode,
    request,
    snapshot,
    previous,
    newId: options.newId ?? defaultNewId,
    issues: [],
    fixes: new Map(),
    evidence,
    numbers: numberEvidence(request, snapshot, evidence),
    names: revampStoreNames(request, snapshot),
    language: request.brief.language || "English",
    owned: revampOwnedPhotoUrls(input),
    replaceable: replaceableSet(snapshot),
    targets: { pages: new Set(), categories: new Set(), products: new Set() },
    hasProducts: revampHasRealProducts(input),
    createsProducts: revampNewProductSlugs(input).size > 0,
    categoryBand: revampCategoryBandAllowed(input),
    modelShots: new Map(),
    autoShots: new Map(),
    goods,
    goodsAliases: goodsAliases(input, goods),
    refContext: new Map(),
    homeNamed: new Set(),
    redraw:
      redrawScope === "all"
        ? "all"
        : new Set((redrawScope ?? []).map((id) => sanitizeShotId(id) ?? id)),
    v5: (revampAnswerPromptVersion(raw) ?? 0) >= REVAMP_SEEDED_PROMPT_VERSION,
    boundedPhotos:
      request.kind === "full" &&
      (input.photoBudget === REVAMP_WORK_BUDGET.photos ||
        (revampAnswerPromptVersion(raw) ?? 0) >= 6),
    omittedPhotos: 0,
    seed: revampDesignSeed(snapshot.storeId, input.revampId),
  };

  readModelShots(ctx, raw);

  // ── Which pages ──────────────────────────────────────────────────────────
  const scope = revampPageScope({ request, snapshot, previous });
  const modelPages = readModelPages(ctx, raw);
  const previousPages = new Map(
    (previous?.pages ?? []).map((p) => [p.slug, p]),
  );
  const scopeBySlug = new Map(scope.pages.map((p) => [p.slug, p]));
  const snapshotBySlug = new Map(snapshot.pages.map((p) => [p.slug, p]));

  const plannedSlugs: string[] = [];
  const newSlugs: string[] = [];
  for (const scopePage of scope.pages) {
    if (!scopePage.write || modelPages.has(scopePage.slug)) {
      plannedSlugs.push(scopePage.slug);
    } else if (previousPages.has(scopePage.slug)) {
      plannedSlugs.push(scopePage.slug);
    }
  }
  let room = scope.newPagesAllowed;
  for (const [slug, page] of modelPages) {
    if (scopeBySlug.has(slug)) continue;
    const existing = snapshotBySlug.get(slug);
    const label = pageLabel(slug);
    // ★ A page the plan does not write is left out with no merchant note:
    //   nothing on the store changes because of it.
    if (REVAMP_SKIPPED_SLUGS.has(slug) || existing?.skipped === "policy") {
      issue(
        ctx,
        `Page "${label}" is a policy page; a redesign never writes the terms, refund, shipping or privacy policy. Leave it out.`,
        null,
      );
      continue;
    }
    if (scope.named) {
      issue(
        ctx,
        `Page "${label}" was not asked for; write only the pages the merchant named.`,
        null,
      );
      continue;
    }
    if (existing) {
      issue(
        ctx,
        existing.skipped
          ? `Page "${label}" cannot be read, so it is never written. Leave it out.`
          : `Page "${label}" is not one of the pages this redesign writes. Leave it out.`,
        null,
      );
      continue;
    }
    if ("error" in validatePageSlug(slug)) {
      issue(
        ctx,
        `pages: "${clipText(text(page.slug), 60)}" cannot be a new page's address; use lowercase words joined by hyphens (not a reserved name such as shop, blogs or collections).`,
        null,
      );
      continue;
    }
    if (room <= 0) {
      issue(
        ctx,
        `Page "${label}" is one page too many; a redesign writes at most ${REVAMP_LIMITS.maxPages} pages.`,
        null,
      );
      continue;
    }
    room -= 1;
    newSlugs.push(slug);
  }

  ctx.targets = revampLinkTargets({
    request,
    snapshot,
    plan: {
      pages: [...plannedSlugs, ...newSlugs].map((slug) => ({
        slug,
      })) as RevampPlannedPage[],
    },
  });

  // ── Build each page ──────────────────────────────────────────────────────
  const pages: WorkingPage[] = [];
  for (const scopePage of scope.pages) {
    const raw = modelPages.get(scopePage.slug);
    const prior = previousPages.get(scopePage.slug);
    const fresh = (): WorkingPage => ({
      slug: scopePage.slug,
      label: pageLabel(scopePage.slug),
      title: "",
      seoTitle: "",
      seoDescription: "",
      create: !scopePage.snapshotPage,
      pageId: scopePage.snapshotPage?.id ?? null,
      snapshotPage: scopePage.snapshotPage,
      sections: [],
      copied: false,
    });
    if (!scopePage.write && prior) {
      pages.push(copyPreviousPage(ctx, prior, scopePage.snapshotPage));
      continue;
    }
    if (raw) {
      const page = fresh();
      buildModelPage(ctx, page, raw);
      pages.push(page);
      continue;
    }
    const label = pageLabel(scopePage.slug);
    issue(
      ctx,
      scopePage.slug === ""
        ? `The homepage is missing; write it with slug "${REVAMP_HOME_SLUG}".`
        : `Page "${label}" is missing; write every page in <scope>.`,
      null,
    );
    // A refinement still has the page as it was; a first plan leaves the
    // store's page as it is.
    if (prior) pages.push(copyPreviousPage(ctx, prior, scopePage.snapshotPage));
  }
  for (const slug of newSlugs) {
    const page: WorkingPage = {
      slug,
      label: slug,
      title: "",
      seoTitle: "",
      seoDescription: "",
      create: true,
      pageId: null,
      snapshotPage: null,
      sections: [],
      copied: false,
    };
    buildModelPage(ctx, page, modelPages.get(slug)!);
    pages.push(page);
  }

  const homeInScope = scope.pages.some((p) => p.slug === "");
  if (homeInScope && !pages.some((p) => p.slug === "")) {
    return {
      plan: null,
      issues: ctx.issues,
      fatal: "The plan has no homepage.",
    };
  }

  for (const page of pages) applyPageRules(ctx, page);
  // A page left with nothing to show is not written.
  const writtenPages = pages.filter((page) => {
    if (page.sections.length > 0) return true;
    pageIssue(
      ctx,
      page,
      `Page "${page.label}" has no sections left; write it from the merchant's facts.`,
      null,
    );
    return false;
  });
  if (writtenPages.length === 0) {
    return {
      plan: null,
      issues: ctx.issues,
      fatal: "The plan has no usable pages.",
    };
  }
  if (homeInScope && !writtenPages.some((p) => p.slug === "")) {
    return {
      plan: null,
      issues: ctx.issues,
      fatal: "The plan has no usable homepage.",
    };
  }

  // ── Design and chrome ────────────────────────────────────────────────────
  const scope_ = request.refineScope;
  const designFromPrevious = !!previous && !!scope_ && !scope_.design;
  const copyFromPrevious = !!previous && !!scope_ && !scope_.copy;
  const menusFromPrevious =
    !!previous && !!scope_ && !scope_.copy && !scope_.layout;

  const industry = (REVAMP_INDUSTRIES as readonly unknown[]).includes(
    raw.industry,
  )
    ? (raw.industry as ThemeIndustry)
    : (previous?.industry ?? "general");
  const direction = (DESIGN_DIRECTION_IDS as readonly unknown[]).includes(
    raw.direction,
  )
    ? (raw.direction as DesignDirection)
    : null;
  if (!direction && !designFromPrevious) {
    issue(
      ctx,
      `direction "${clipText(text(raw.direction), 40)}" is not one of the design directions in <design_directions>.`,
      null,
    );
  }

  const usedSchemes = new Set<SectionScheme>();
  for (const page of writtenPages) {
    for (const s of page.sections) {
      const scheme = s.item.style?.scheme;
      if (scheme) usedSchemes.add(scheme);
    }
  }
  const design =
    designFromPrevious && previous
      ? { design: clone(previous.design), fontPairing: null }
      : buildDesign(
          ctx,
          raw.design,
          usedSchemes,
          direction ?? previous?.direction ?? null,
        );
  const appearance =
    designFromPrevious && previous
      ? clone(previous.appearance)
      : buildAppearance(raw.appearance);
  // ★★ The plan's direction. A v5 answer that left it out (and has no
  //    parent's to keep) gets one picked for the store, among the directions
  //    its page colour suits and its industry's first, never the same
  //    "classic-and-trusted" for every store; a v4 answer keeps that.
  const planDirection =
    designFromPrevious && previous
      ? previous.direction
      : (direction ??
        previous?.direction ??
        (ctx.v5
          ? fallbackDirection(
              ctx,
              design.design.palette.cream ??
                themeFallbackPalette(snapshot).cream,
              industry,
            )
          : "classic-and-trusted"));

  ctx.homeNamed = homeNamedLinks(ctx, writtenPages);
  const menus = isRecord(raw.menus) ? raw.menus : {};
  const header =
    menusFromPrevious && previous
      ? buildHeader(ctx, previous.menus.header, true)
      : buildHeader(ctx, menus.header, false);
  const footerGroups =
    menusFromPrevious && previous
      ? buildFooter(ctx, previous.menus.footerGroups, true)
      : buildFooter(ctx, menus.footerGroups, false);

  const store = snapshot.storeName;
  const rawAnnouncement = isRecord(raw.announcement) ? raw.announcement : {};
  const rawBrand = isRecord(raw.brand) ? raw.brand : {};
  const rawNewsletter = isRecord(raw.newsletter) ? raw.newsletter : {};
  let announcement: RevampSitePlan["announcement"];
  let brand: RevampSitePlan["brand"];
  let newsletter: RevampSitePlan["newsletter"];
  if (copyFromPrevious && previous) {
    const href = checkRevampLink(previous.announcement.href, ctx.targets) ?? "";
    announcement = {
      text: previous.announcement.text,
      href: previous.announcement.text ? href : "",
    };
    brand = { ...previous.brand };
    newsletter = { ...previous.newsletter };
  } else {
    const announcementText = clipText(
      checkCopy(ctx, text(rawAnnouncement.text), "announcement.text"),
      REVAMP_TEXT_LIMITS.announcement,
    );
    let announcementHref = checkRevampLink(
      text(rawAnnouncement.href),
      ctx.targets,
    );
    if (announcementHref === null) {
      issue(
        ctx,
        `announcement.href "${clipText(text(rawAnnouncement.href), 80)}" will not exist after Apply. ${LINK_HELP}`,
        "link",
      );
      announcementHref = "";
    }
    announcement = {
      text: announcementText,
      href: announcementText ? announcementHref : "",
    };
    brand = {
      tagline: chromeText(
        ctx,
        rawBrand.tagline,
        store,
        "brand.tagline",
        REVAMP_TEXT_LIMITS.tagline,
        () => briefLine(ctx, REVAMP_TEXT_LIMITS.tagline) || store,
        false,
      ),
      blurb: chromeText(
        ctx,
        rawBrand.blurb,
        store,
        "brand.blurb",
        REVAMP_TEXT_LIMITS.blurb,
        () => briefLine(ctx, REVAMP_TEXT_LIMITS.blurb) || store,
        false,
      ),
    };
    // ★ v5: the newsletter's words the answer left out are picked for the
    //   store from neutral lines, never "Stay in touch" for everyone.
    const letterHeading = ctx.v5
      ? pick(ctx, "newsletter.heading", REVAMP_NEUTRAL_COPY.newsletterHeading)
      : "Stay in touch";
    const letterSubtext = ctx.v5
      ? revampNeutralLine(
          pick(
            ctx,
            "newsletter.subtext",
            REVAMP_NEUTRAL_COPY.newsletterSubtext,
          ),
          store,
        )
      : `News from ${store} by email.`;
    const letterButton = ctx.v5
      ? pick(ctx, "newsletter.button", REVAMP_NEUTRAL_COPY.newsletterButton)
      : "Subscribe";
    newsletter = {
      heading: chromeText(
        ctx,
        rawNewsletter.heading,
        letterHeading,
        "newsletter.heading",
        REVAMP_TEXT_LIMITS.newsletterHeading,
        () => letterHeading,
        false,
      ),
      subtext: chromeText(
        ctx,
        rawNewsletter.subtext,
        letterSubtext,
        "newsletter.subtext",
        REVAMP_TEXT_LIMITS.newsletterSubtext,
        () => letterSubtext,
        false,
      ),
      buttonLabel:
        clipText(
          checkCopy(
            ctx,
            text(rawNewsletter.buttonLabel),
            "newsletter.buttonLabel",
          ),
          REVAMP_TEXT_LIMITS.newsletterButton,
        ) || letterButton,
    };
  }

  // ── Products' copy ───────────────────────────────────────────────────────
  const keys = new Set(request.products.map((p) => p.key));
  const productCopy: Record<string, string> = {};
  if (previous && scope_ && !scope_.products) {
    for (const [key, value] of Object.entries(previous.productCopy)) {
      if (keys.has(key)) productCopy[key] = value;
    }
  } else {
    const rawCopy = Array.isArray(raw.productCopy) ? raw.productCopy : [];
    rawCopy.forEach((entry, i) => {
      if (!isRecord(entry)) return;
      const key = text(entry.key).trim();
      if (!keys.has(key) || productCopy[key] !== undefined) return;
      const value = clipText(
        checkCopy(
          ctx,
          text(entry.description),
          `productCopy[${i}] (${key}) description`,
        ),
        REVAMP_TEXT_LIMITS.productCopy,
      );
      if (value) productCopy[key] = value;
    });
  }
  // ★ Keyed by the merchant's products, in their order: the model's polish,
  //   else the merchant's own description as they wrote it.
  const productDescriptions: Record<string, string> = {};
  for (const product of request.products) {
    const value =
      productCopy[product.key] ||
      clipText(
        cleanRevampCopy(product.description),
        REVAMP_TEXT_LIMITS.productCopy,
      );
    if (value) productDescriptions[product.key] = value;
  }

  // ── Shots ────────────────────────────────────────────────────────────────
  const shots = buildShots(
    ctx,
    writtenPages,
    // ★ A v4 answer's default art direction named no style when it left the
    //   direction out; a v5 one names the direction picked for the store.
    ctx.v5 ? planDirection : (direction ?? previous?.direction ?? ""),
  );
  // A section the photo pass dropped may have left a rule unmet: fixed
  // quietly, since the model did nothing wrong.
  for (const page of writtenPages) {
    enforceNewsletterQuietly(page);
    enforceSchemes(page, page.slug === "");
  }
  if (request.kind === "full") {
    photoLedIssue(ctx, writtenPages, shots.shots.length, scope.named);
  }

  // ── Notes ────────────────────────────────────────────────────────────────
  const notes: string[] = [];
  if (mode === "lenient") {
    for (const kind of FIX_ORDER) {
      const count = ctx.fixes.get(kind);
      if (count) notes.push(FIX_NOTES[kind](count));
    }
  }
  const modelNotes = (Array.isArray(raw.notes) ? raw.notes : [])
    .map((note) =>
      clipText(cleanRevampCopy(text(note)), REVAMP_TEXT_LIMITS.note),
    )
    .filter(
      (note) =>
        !!note &&
        // ★ The card never talks about credits; a model's note might.
        !/\bcredits?\b/i.test(note) &&
        readsAsLanguage(withoutStoreNames(note, ctx.names), ctx.language),
    )
    .slice(0, 2);
  const allNotes = [
    ...notes.slice(0, MAX_NOTES - Math.min(2, modelNotes.length)),
    ...modelNotes,
  ].slice(0, MAX_NOTES);

  const summary =
    clipText(cleanRevampCopy(text(raw.summary)), REVAMP_TEXT_LIMITS.summary) ||
    previous?.summary ||
    `A redesigned storefront for ${store}.`;

  const plan: RevampSitePlan = {
    summary,
    industry,
    direction: planDirection,
    design: design.design,
    appearance,
    announcement,
    brand,
    newsletter,
    pages: writtenPages.map((page) => ({
      slug: page.slug,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      create: page.create,
      pageId: page.pageId,
      sections: page.sections.map((s) => s.item),
    })),
    menus: { header, footerGroups },
    shots: shots.shots,
    bindings: shots.bindings,
    productCopy: productDescriptions,
    notes: allNotes,
    // ★ Always empty here: what a plan leaves out is the budget step's list
    //   (fitBudget). Pages a redesign never writes are the snapshot's.
    skipped: ctx.omittedPhotos
      ? [
          {
            label: `${ctx.omittedPhotos} new photograph${ctx.omittedPhotos === 1 ? "" : "s"}`,
            reason:
              "The redesign uses a smaller set of coordinated photographs.",
          },
        ]
      : [],
  };
  plan.basis = planBasis(input, plan, {
    previous,
    copiedPages: writtenPages.filter((p) => p.copied).map((p) => p.slug),
    carriedShots: shots.carried,
    designFromPrevious,
    chromeFromPrevious: menusFromPrevious && designFromPrevious,
  });
  return { plan, issues: ctx.issues, fatal: null };
}

/**
 * What the plan was built from, and what a refinement carries over from the
 * plan it builds on unchanged. ★ This is what a refinement is charged by
 * (money-1): the owner's rule is per item, at today's prices, so a page,
 * photograph, look or chrome the parent already made is not charged again.
 * "Unchanged" is read two ways: the scope said to keep it (so the compiler
 * copied it), or the model wrote it again exactly as the parent had it.
 */
function planBasis(
  input: { request: RevampRequest; snapshot: RevampSnapshot },
  plan: RevampSitePlan,
  carry: {
    previous: RevampSitePlan | null;
    copiedPages: string[];
    carriedShots: string[];
    designFromPrevious: boolean;
    chromeFromPrevious: boolean;
  },
): RevampPlanBasis {
  const { request } = input;
  const existing = revampExistingProductKeys(input);
  const productKeys = request.products.map((p) => p.key);
  const categoryChanges = request.categories.map(revampCategoryChangeKey);
  const { previous } = carry;
  if (!previous) {
    return {
      categories: request.categories.length,
      categoryChanges,
      productKeys,
      existingProductKeys: productKeys.filter((key) => existing.has(key)),
      carried: null,
    };
  }
  const chromeOf = (p: RevampSitePlan) => ({
    menus: p.menus,
    appearance: p.appearance,
    announcement: p.announcement,
    newsletter: p.newsletter,
    brand: p.brand,
  });
  // ★ A parent compiled before the basis existed names its products by the
  //   copy it wrote for each, which it wrote for every product it had.
  const parentProducts = new Set(
    previous.basis?.productKeys ?? Object.keys(previous.productCopy ?? {}),
  );
  return {
    categories: request.categories.length,
    categoryChanges,
    productKeys,
    existingProductKeys: productKeys.filter((key) => existing.has(key)),
    carried: {
      pages: carry.copiedPages,
      shots: carry.carriedShots,
      design:
        carry.designFromPrevious || sameJson(plan.design, previous.design),
      chrome:
        carry.chromeFromPrevious ||
        sameJson(chromeOf(plan), chromeOf(previous)),
      // ★ An unapplied parent's changes are carried in the request, an
      //   applied parent's are not (they are on the store), so the parent's
      //   are found by key; an older parent that recorded no keys made none
      //   this can prove.
      categories: carriedCategoryCount(
        request.categories,
        previous.basis?.categoryChanges,
      ),
      products: productKeys.filter((key) => parentProducts.has(key)),
    },
  };
}

/** Photos the floor asks of a full redesign (live-1). */
export const REVAMP_PHOTO_FLOOR = { homePhotos: 3, shots: 8 } as const;

/** The distinct photographs a page shows outside product sections (a phone crop is the same photo). */
function photosOutsideProducts(page: WorkingPage): number {
  const seen = new Set<string>();
  for (const section of enabledSections(page)) {
    if (PRODUCT_SECTION_TYPES.has(section.item.type)) continue;
    for (const leaf of sectionImageLeaves(section.item)) {
      if (lastKey(leaf.path) === "mobile_image_url") continue;
      seen.add(leaf.value.trim());
    }
  }
  return seen.size;
}

/**
 * ★ A FULL REDESIGN IS LED BY PHOTOGRAPHS (live-1). The live runs came back
 *   as a page of words with one hero, which reads as a template, not a shop.
 *   ONE repair sentence, strict only: a style floor rather than a defect, so
 *   the lenient pass takes the plan as it is and the merchant is never told
 *   about it. The homepage counts when the plan writes it; the whole plan's
 *   shots count only when no pages were named (two named pages cannot hold
 *   eight photographs, nor should they).
 */
function photoLedIssue(
  ctx: Ctx,
  pages: WorkingPage[],
  shotCount: number,
  named: boolean,
): void {
  const reasons: string[] = [];
  const home = pages.find((p) => p.slug === "" && !p.copied);
  if (home) {
    const n = photosOutsideProducts(home);
    if (n < REVAMP_PHOTO_FLOOR.homePhotos) {
      reasons.push(
        `the homepage shows ${n} photograph${n === 1 ? "" : "s"} outside product sections (it needs at least ${REVAMP_PHOTO_FLOOR.homePhotos})`,
      );
    }
  }
  if (!ctx.boundedPhotos && !named && shotCount < REVAMP_PHOTO_FLOOR.shots) {
    reasons.push(
      `the plan has ${shotCount} shot${shotCount === 1 ? "" : "s"} in all (it needs at least ${REVAMP_PHOTO_FLOOR.shots})`,
    );
  }
  if (reasons.length === 0) return;
  strictOnly(
    ctx,
    // ★ The counts are of photographs a page shows: a shot no image field
    //   names is dropped before they are taken (buildShots), so describing
    //   more shots without placing them never closes the gap (output-1).
    `The redesign is short of photographs: ${reasons.join(" and ")}. Open the homepage with a hero_carousel of two or three slides, add a band led by photographs (a gallery of four to six photos, a tile_grid whose tiles, or a multicolumn whose items, each have a photo, or a media_text with two stories, each with a photo), give every other page at least one photograph, and describe about 10 to 20 shots; a shot counts only when an image field names it (an image_url holding ${REVAMP_SLOT_PREFIX}<shot id>), and one that nothing names is dropped.`,
  );
}

/** After photos were cleared, a newsletter still closes its page. */
function enforceNewsletterQuietly(page: WorkingPage): void {
  const letters = page.sections.filter((s) => s.item.type === "newsletter");
  if (letters.length === 0) return;
  const closing = letters[letters.length - 1];
  page.sections = [...page.sections.filter((s) => s !== closing), closing];
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

/**
 * Strict: the plan, or every problem as a sentence for one repair call.
 * `plan` is null whenever `issues` is not empty.
 */
export function compileRevampSite(
  raw: unknown,
  input: RevampCompileInput,
  options: RevampCompileOptions = {},
): RevampCompileResult {
  const result = buildPlan(raw, input, "strict", options);
  if (result.fatal || result.issues.length > 0 || !result.plan) {
    const issues = result.issues.length
      ? [...result.issues]
      : [result.fatal ?? "The plan could not be read."];
    if (issues.length >= MAX_ISSUES) {
      issues.push(
        "There are more problems of the same kinds; fix every one of them.",
      );
    }
    return { plan: null, issues };
  }
  return { plan: result.plan, issues: [] };
}

/**
 * Lenient: the same rules, each problem fixed mechanically and noted. Throws
 * `RevampStepError("plan_invalid")` only when nothing usable is left.
 */
export function finalizeRevampSite(
  raw: unknown,
  input: RevampCompileInput,
  options: RevampCompileOptions = {},
): RevampSitePlan {
  const result = buildPlan(raw, input, "lenient", options);
  if (result.fatal || !result.plan) {
    throw new RevampStepError(
      "plan_invalid",
      result.fatal ?? "The site plan could not be used.",
    );
  }
  return result.plan;
}
