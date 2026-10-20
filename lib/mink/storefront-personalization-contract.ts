// ---------------------------------------------------------------------------
// Personalise a storefront: the rules, with no I/O.
//
// A merchant picks a theme at signup and gets the theme's words and the
// theme's photographs: a grocery theme's "Fresh produce, delivered" over a
// stock bowl of tomatoes, whatever the shop actually sells. Mink interviews
// the merchant and turns the answers into ONE proposal that rewrites the
// store's pages, draws new photographs for the most visible slots, adjusts
// the colours and type, retires the theme's sample products and changes the
// categories the merchant confirmed. One review card, one approval.
//
// This module decides WHAT may change, field by field. The server modules
// read the store, ask the writer and the image model, and write:
//   storefront-personalization-context.ts   the read (model summary + target)
//   storefront-personalization-writer.ts    the copy and photo-brief model call
//   storefront-personalization-proposals.ts the one charged proposal
//   storefront-personalization-actions.ts   the approval and the write
//
// ★★ THE FIELD TABLE IS AN ALLOWLIST. A section type absent from it, or a
//    field absent from its entry, is never written. Links (`*_href`),
//    colours, layout settings, product and category sources and custom code
//    are not in it, so a personalisation can change what a page SAYS and
//    SHOWS but never where it sends a shopper or how it is built.
//
// ★★ SAMPLE CONTENT THAT MAKES A CLAIM IS HIDDEN, NOT REWRITTEN. A theme
//    ships customer quotes, press logos, a countdown, a before-and-after
//    pair and shoppable hotspots that point at its own sample products.
//    Rewriting a testimonial for a real shop is inventing a review; drawing
//    a new "press" strip is inventing coverage. Those sections are switched
//    off (kept in the Builder, so the merchant can fill them with real ones
//    and switch them back on), and the card says which and why.
//
// ★ PURE AND CLIENT-SAFE: the review card reads its labels from here, so no
//   server import and no Node API. Digests live in the server modules.
// ---------------------------------------------------------------------------

import { MINK_DRAFT_CONFIG } from "./draft-types";
import {
  FAQ_ANSWER_MAX_CHARS,
  TICKER_MESSAGE_MAX_CHARS,
  USP_ICONS,
  type HomepageSectionType,
  type UspIcon,
} from "@/lib/homepage/section-types";
import type { PageSectionItem } from "@/lib/sections/registry";

export const MINK_PERSONALIZATION_SCHEMA_VERSION = 1 as const;

/**
 * Today's prices (owner's decision, 2026-10-20): a page costs what a layout
 * proposal costs, a photo what a generated image costs, the colours what a
 * design proposal costs, the header, footer and store description what a
 * Website Builder change costs, and a category what a category proposal
 * costs. Read from the draft table so the two cannot drift.
 * ★ Unpublishing the theme's sample products has no price of its own today,
 *   so it is free.
 */
export const MINK_PERSONALIZATION_PRICES = {
  page: MINK_DRAFT_CONFIG.storefront_layout.expectedCredits,
  photo: MINK_DRAFT_CONFIG.media_image.expectedCredits,
  design: MINK_DRAFT_CONFIG.storefront_design.expectedCredits,
  chrome: MINK_DRAFT_CONFIG.website_builder.expectedCredits,
  category: MINK_DRAFT_CONFIG.category_update.expectedCredits,
} as const;

/**
 * Photos in one proposal. ★ A SPEND AND TIME CEILING: each photo is a paid
 * provider call of about 20 s, drawn while the merchant waits; the rest of a
 * large theme is a second, smaller personalisation ("make the rest").
 */
export const MINK_PERSONALIZATION_MAX_PHOTOS = 12;
/** Pages in one proposal, the homepage included. */
export const MINK_PERSONALIZATION_MAX_PAGES = 8;
/** Category changes in one proposal. */
export const MINK_PERSONALIZATION_MAX_CATEGORY_CHANGES = 12;
/** The largest charge one proposal may carry (the database allows this kind up to it). */
export const MINK_PERSONALIZATION_MAX_CREDITS = 200;

/**
 * Page slugs a personalisation never writes. A policy is the merchant's
 * legal text (Settings, Policies); rewriting it from a brand brief would put
 * words the merchant never agreed to into a document customers rely on.
 */
export const MINK_PERSONALIZATION_SKIPPED_SLUGS: ReadonlySet<string> = new Set([
  "terms",
  "refund-policy",
  "shipping-policy",
  "privacy-policy",
]);

// ---------------------------------------------------------------------------
// The field table.
// ---------------------------------------------------------------------------

/** A photo slot's frame, which decides the shape the image model draws. */
export type PersonalizationPhotoShape =
  | "wide"
  | "portrait"
  | "square"
  | "landscape";

export const PERSONALIZATION_PHOTO_ASPECT: Record<
  PersonalizationPhotoShape,
  "21:9" | "4:5" | "1:1" | "4:3"
> = {
  wide: "21:9",
  portrait: "4:5",
  square: "1:1",
  landscape: "4:3",
};

interface TextFieldSpec {
  key: string;
  label: string;
  max: number;
  /** `rich` is a block of prose the server turns into simple HTML. */
  kind: "line" | "text" | "rich";
  /** May be left empty; the writer may clear it rather than invent one. */
  optional?: boolean;
}

interface PhotoSpec {
  key: string;
  altKey?: string;
  label: string;
  shape: (config: Record<string, unknown>) => PersonalizationPhotoShape;
  /**
   * Cleared when the photo is replaced. ★ A phone-only image or a video
   *   would otherwise keep showing the theme's picture over the new one, and
   *   a focal point was chosen for the old photo's subject.
   */
  clears?: string[];
  /** How prominent the slot is (0 most), for the photo budget. */
  rank: number;
  /** Only for list items whose own value says they hold a photo. */
  when?: (item: Record<string, unknown>) => boolean;
}

interface ListSpec {
  key: string;
  itemLabel: string;
  fields: TextFieldSpec[];
  photos?: PhotoSpec[];
}

/**
 * A list the writer replaces whole: the theme's items are claims about the
 * theme's shop (its delivery promise, its returns window, its questions), so
 * the honest rewrite may have fewer items than the theme had, or none.
 */
interface ReplacedListSpec {
  key: "items" | "messages";
  kind: "faq" | "usp" | "ticker";
  label: string;
  maxItems: number;
}

export interface PersonalizationSectionSpec {
  handling: "rewrite" | "hide" | "keep";
  /** Why a hidden section is hidden, in the merchant's words. */
  hideReason?: string;
  fields?: TextFieldSpec[];
  photos?: PhotoSpec[];
  lists?: ListSpec[];
  replaced?: ReplacedListSpec;
}

const HERO_CLEARS = ["mobile_image_url", "video_url", "focal_x", "focal_y"];

const ratioShape =
  (key: string) =>
  (config: Record<string, unknown>): PersonalizationPhotoShape =>
    config[key] === "square"
      ? "square"
      : config[key] === "landscape"
        ? "landscape"
        : "portrait";

const heading = (max = 120, optional = false): TextFieldSpec => ({
  key: "heading",
  label: "Heading",
  max,
  kind: "line",
  optional,
});
const subheading: TextFieldSpec = {
  key: "subheading",
  label: "Subheading",
  max: 240,
  kind: "text",
  optional: true,
};
const eyebrow: TextFieldSpec = {
  key: "eyebrow",
  label: "Small label above the heading",
  max: 60,
  kind: "line",
  optional: true,
};
const ctaLabel: TextFieldSpec = {
  key: "cta_label",
  label: "Button label",
  max: 30,
  kind: "line",
  optional: true,
};

function hidden(reason: string): PersonalizationSectionSpec {
  return { handling: "hide", hideReason: reason };
}

export const PERSONALIZATION_SECTION_SPECS: Record<
  HomepageSectionType,
  PersonalizationSectionSpec
> = {
  hero: {
    handling: "rewrite",
    fields: [
      {
        key: "badge_text",
        label: "Badge",
        max: 40,
        kind: "line",
        optional: true,
      },
      heading(120, true),
      subheading,
      ctaLabel,
    ],
    photos: [
      {
        key: "image_url",
        label: "Banner photo",
        shape: (config) => (config.variant === "split" ? "portrait" : "wide"),
        clears: HERO_CLEARS,
        rank: 0,
      },
    ],
  },
  hero_carousel: {
    handling: "rewrite",
    lists: [
      {
        key: "slides",
        itemLabel: "Slide",
        fields: [heading(120, true), subheading, ctaLabel],
        photos: [
          {
            key: "image_url",
            label: "Slide photo",
            // `layout` lives on the carousel, read through the item's parent.
            shape: (config) =>
              config.__parentLayout === "split" ? "portrait" : "wide",
            clears: HERO_CLEARS,
            rank: 0,
          },
        ],
      },
    ],
  },
  promo_banner: {
    handling: "rewrite",
    fields: [
      heading(120, true),
      {
        key: "subtext",
        label: "Text",
        max: 240,
        kind: "text",
        optional: true,
      },
      ctaLabel,
    ],
    photos: [
      {
        key: "image_url",
        label: "Banner photo",
        shape: () => "wide",
        rank: 0,
      },
    ],
  },
  tile_grid: {
    handling: "rewrite",
    fields: [heading(120, true), subheading],
    lists: [
      {
        key: "tiles",
        itemLabel: "Tile",
        fields: [
          { key: "title", label: "Title", max: 60, kind: "line" },
          {
            key: "subtitle",
            label: "Subtitle",
            max: 120,
            kind: "line",
            optional: true,
          },
        ],
        photos: [
          {
            key: "image_url",
            label: "Tile photo",
            shape: () => "square",
            rank: 2,
          },
        ],
      },
    ],
  },
  media_text: {
    handling: "rewrite",
    fields: [
      eyebrow,
      heading(120, true),
      { key: "body", label: "Text", max: 1_200, kind: "text", optional: true },
      ctaLabel,
    ],
    photos: [
      {
        key: "image_url",
        altKey: "image_alt",
        label: "Photo beside the text",
        shape: ratioShape("media_ratio"),
        rank: 1,
      },
    ],
    lists: [
      {
        key: "stories",
        itemLabel: "Story",
        fields: [
          eyebrow,
          heading(120, true),
          {
            key: "body",
            label: "Text",
            max: 1_200,
            kind: "text",
            optional: true,
          },
          ctaLabel,
        ],
        photos: [
          {
            key: "image_url",
            altKey: "image_alt",
            label: "Story photo",
            shape: (config) =>
              ratioShape("media_ratio")({
                media_ratio: config.__parentRatio,
              }),
            rank: 3,
          },
        ],
      },
    ],
  },
  gallery: {
    handling: "rewrite",
    fields: [heading(120, true), subheading],
    lists: [
      {
        key: "items",
        itemLabel: "Picture",
        fields: [
          {
            key: "caption",
            label: "Caption",
            max: 140,
            kind: "line",
            optional: true,
          },
        ],
        photos: [
          {
            key: "image_url",
            altKey: "image_alt",
            label: "Gallery photo",
            shape: (config) =>
              ratioShape("image_ratio")({ image_ratio: config.__parentRatio }),
            rank: 3,
          },
        ],
      },
    ],
  },
  testimonials: hidden(
    "Sample customer quotes from the theme. Add your own customers' words in Website Builder, then switch it back on.",
  ),
  video: {
    handling: "rewrite",
    fields: [eyebrow, heading(120, true), subheading],
  },
  newsletter: {
    handling: "rewrite",
    fields: [
      eyebrow,
      heading(120, true),
      subheading,
      {
        key: "button_label",
        label: "Button label",
        max: 30,
        kind: "line",
        optional: true,
      },
    ],
  },
  usp_bar: {
    handling: "rewrite",
    replaced: {
      key: "items",
      kind: "usp",
      label: "Trust points",
      maxItems: 6,
    },
  },
  ticker: {
    handling: "rewrite",
    replaced: {
      key: "messages",
      kind: "ticker",
      label: "Scrolling messages",
      maxItems: 8,
    },
  },
  faq_accordion: {
    handling: "rewrite",
    fields: [heading(120, true), subheading],
    replaced: { key: "items", kind: "faq", label: "Questions", maxItems: 8 },
  },
  accordion: {
    handling: "rewrite",
    fields: [heading(120, true), subheading],
    lists: [
      {
        key: "items",
        itemLabel: "Row",
        fields: [
          { key: "heading", label: "Heading", max: 120, kind: "line" },
          {
            key: "body",
            label: "Text",
            max: 800,
            kind: "text",
            optional: true,
          },
        ],
        photos: [
          {
            key: "image_url",
            altKey: "image_alt",
            label: "Row photo",
            shape: () => "square",
            rank: 3,
            when: (item) => item.type === "image",
          },
        ],
      },
    ],
  },
  comparison: hidden(
    "A sample comparison of the theme's products. Build your own in Website Builder, then switch it back on.",
  ),
  multicolumn: {
    handling: "rewrite",
    fields: [eyebrow, heading(120, true), subheading],
    lists: [
      {
        key: "items",
        itemLabel: "Column",
        fields: [
          { key: "heading", label: "Heading", max: 80, kind: "line" },
          {
            key: "body",
            label: "Text",
            max: 300,
            kind: "text",
            optional: true,
          },
          ctaLabel,
        ],
        photos: [
          {
            key: "image_url",
            altKey: "image_alt",
            label: "Column photo",
            shape: (config) =>
              ratioShape("image_ratio")({ image_ratio: config.__parentRatio }),
            rank: 2,
          },
        ],
      },
    ],
  },
  image_marquee: {
    handling: "rewrite",
    lists: [
      {
        key: "items",
        itemLabel: "Picture",
        fields: [],
        photos: [
          {
            key: "image_url",
            altKey: "image_alt",
            label: "Scrolling picture",
            shape: (config) =>
              ratioShape("image_ratio")({ image_ratio: config.__parentRatio }),
            rank: 4,
          },
        ],
      },
    ],
  },
  image_hotspots: hidden(
    "A shoppable picture whose markers point at the theme's sample products.",
  ),
  before_after: hidden("A sample before-and-after pair from the theme."),
  product_spotlight: {
    handling: "rewrite",
    fields: [
      eyebrow,
      heading(120, true),
      { key: "body", label: "Text", max: 600, kind: "text", optional: true },
      ctaLabel,
    ],
  },
  logo_strip: hidden(
    "Sample press and stockist logos from the theme. Add real ones in Website Builder, then switch it back on.",
  ),
  countdown: hidden("A sample countdown to a date the theme chose."),
  featured_products: {
    handling: "rewrite",
    fields: [heading(120, true), subheading],
  },
  shop_by_category: {
    handling: "rewrite",
    fields: [heading(120, true), subheading],
  },
  latest_blogs: {
    handling: "rewrite",
    fields: [heading(120, true), subheading],
  },
  rich_text: {
    handling: "rewrite",
    fields: [{ key: "html", label: "Text", max: 4_000, kind: "rich" }],
  },
  // ★ NEVER TOUCHED: the merchant's own HTML, CSS and JS.
  custom_code: { handling: "keep" },
};

// ---------------------------------------------------------------------------
// The inventory: what the writer may rewrite and where photos may go.
// ---------------------------------------------------------------------------

export type PersonalizationPath = Array<string | number>;

export interface PersonalizationTextRef {
  ref: string;
  pageSlug: string;
  sectionId: string;
  path: PersonalizationPath;
  label: string;
  max: number;
  kind: TextFieldSpec["kind"];
  optional: boolean;
  current: string;
}

export interface PersonalizationPhotoRef {
  ref: string;
  pageSlug: string;
  sectionId: string;
  sectionType: HomepageSectionType;
  /** The URL field within the section's config. */
  path: PersonalizationPath;
  altPath: PersonalizationPath | null;
  clears: PersonalizationPath[];
  label: string;
  shape: PersonalizationPhotoShape;
  current: string;
  rank: number;
  /** Document order across the whole proposal, for a stable sort. */
  order: number;
  /** A category image rather than a page slot. */
  categorySlug?: string;
}

export interface PersonalizationListRef {
  ref: string;
  pageSlug: string;
  sectionId: string;
  key: "items" | "messages";
  kind: "faq" | "usp" | "ticker";
  label: string;
  maxItems: number;
  current: Array<Record<string, string>> | string[];
}

export interface PersonalizationHiddenSection {
  pageSlug: string;
  sectionId: string;
  type: HomepageSectionType;
  reason: string;
}

export interface PersonalizationPageInventory {
  pageSlug: string;
  title: string;
  texts: PersonalizationTextRef[];
  photos: PersonalizationPhotoRef[];
  lists: PersonalizationListRef[];
  hidden: PersonalizationHiddenSection[];
}

/** A counter shared by every page so refs are unique across a proposal. */
export interface PersonalizationRefCounter {
  text: number;
  photo: number;
  list: number;
  order: number;
}

export function newRefCounter(): PersonalizationRefCounter {
  return { text: 0, photo: 0, list: 0, order: 0 };
}

/**
 * Every field the writer may rewrite on one page, every photo slot, and the
 * sections that will be hidden. Disabled sections are left out: a shopper
 * does not see them, and rewriting them would charge for nothing visible.
 */
export function buildPageInventory(
  pageSlug: string,
  title: string,
  sections: readonly PageSectionItem[],
  counter: PersonalizationRefCounter,
): PersonalizationPageInventory {
  const inventory: PersonalizationPageInventory = {
    pageSlug,
    title,
    texts: [],
    photos: [],
    lists: [],
    hidden: [],
  };
  for (const section of sections) {
    if (!section.enabled) continue;
    const spec = PERSONALIZATION_SECTION_SPECS[section.type];
    if (!spec || spec.handling === "keep") continue;
    if (spec.handling === "hide") {
      inventory.hidden.push({
        pageSlug,
        sectionId: section.id,
        type: section.type,
        reason: spec.hideReason ?? "Sample content from the theme.",
      });
      continue;
    }
    const config = asRecord(section.config);
    collectFields(inventory, counter, section, config, spec.fields ?? [], []);
    collectPhotos(inventory, counter, section, config, spec.photos ?? [], []);
    for (const list of spec.lists ?? []) {
      const items = Array.isArray(config[list.key]) ? config[list.key] : [];
      (items as unknown[]).forEach((rawItem, index) => {
        const item = asRecord(rawItem);
        const withParent = {
          ...item,
          __parentLayout: config.layout,
          __parentRatio: config.media_ratio ?? config.image_ratio,
        };
        const prefix = [list.key, index];
        collectFields(
          inventory,
          counter,
          section,
          item,
          list.fields.map((field) => ({
            ...field,
            label: `${list.itemLabel} ${index + 1} ${field.label.toLowerCase()}`,
          })),
          prefix,
        );
        collectPhotos(
          inventory,
          counter,
          section,
          withParent,
          (list.photos ?? []).map((photo) => ({
            ...photo,
            label: `${photo.label} ${index + 1}`,
          })),
          prefix,
        );
      });
    }
    if (spec.replaced) {
      const raw = config[spec.replaced.key];
      const current =
        spec.replaced.kind === "ticker"
          ? (Array.isArray(raw) ? raw : []).filter(
              (value): value is string => typeof value === "string",
            )
          : (Array.isArray(raw) ? raw : []).map((value) =>
              stringFields(asRecord(value)),
            );
      counter.list += 1;
      inventory.lists.push({
        ref: `l${counter.list}`,
        pageSlug,
        sectionId: section.id,
        key: spec.replaced.key,
        kind: spec.replaced.kind,
        label: spec.replaced.label,
        maxItems: spec.replaced.maxItems,
        current,
      });
    }
  }
  return inventory;
}

function collectFields(
  inventory: PersonalizationPageInventory,
  counter: PersonalizationRefCounter,
  section: PageSectionItem,
  config: Record<string, unknown>,
  fields: readonly TextFieldSpec[],
  prefix: PersonalizationPath,
) {
  for (const field of fields) {
    const value = config[field.key];
    // ★ ONLY A FIELD THE SECTION HAS. A missing key is a setting the theme
    //   chose not to use; adding copy there would add something visible the
    //   merchant never had.
    if (typeof value !== "string") continue;
    counter.text += 1;
    inventory.texts.push({
      ref: `t${counter.text}`,
      pageSlug: inventory.pageSlug,
      sectionId: section.id,
      path: [...prefix, field.key],
      label: field.label,
      max: field.max,
      kind: field.kind,
      optional: field.optional === true,
      current: value,
    });
  }
}

function collectPhotos(
  inventory: PersonalizationPageInventory,
  counter: PersonalizationRefCounter,
  section: PageSectionItem,
  config: Record<string, unknown>,
  photos: readonly PhotoSpec[],
  prefix: PersonalizationPath,
) {
  for (const photo of photos) {
    const value = config[photo.key];
    // ★ ONLY A SLOT THAT HOLDS A PHOTO NOW. A colour tile stays a colour
    //   tile: drawing a picture into it would change the design, not replace
    //   the theme's picture.
    if (typeof value !== "string" || !value.trim()) continue;
    // ★★ ONLY THE THEME'S OWN PICTURES ARE REPLACED. A photo the merchant
    //   uploaded is their goods, and one Mink already drew for them is
    //   already theirs; redrawing either over their head is the opposite of
    //   personalising. It is also what keeps "make the rest" from buying the
    //   first pass's photos a second time.
    if (!isThemePhotoUrl(value)) continue;
    if (photo.when && !photo.when(config)) continue;
    counter.photo += 1;
    counter.order += 1;
    inventory.photos.push({
      ref: `p${counter.photo}`,
      pageSlug: inventory.pageSlug,
      sectionId: section.id,
      sectionType: section.type,
      path: [...prefix, photo.key],
      altPath: photo.altKey ? [...prefix, photo.altKey] : null,
      clears: (photo.clears ?? []).map((key) => [...prefix, key]),
      label: photo.label,
      shape: photo.shape(config),
      current: value,
      rank: photo.rank,
      order: counter.order,
    });
  }
}

/**
 * A picture that came with the theme: a bundled theme's own asset
 * (`/themes/{id}/…`) or a published Theme Studio release's copy in our
 * bucket (`…/theme-releases/…`). An ALLOWLIST, because anything else on a
 * page is something a person chose: a Media Library upload, a product
 * photograph, a picture Mink made, or a legacy upload from before StoreMink
 * had themes. Not knowing where a picture came from means keeping it.
 */
export function isThemePhotoUrl(url: string): boolean {
  const value = url.trim();
  if (value.startsWith("/themes/")) return !value.includes("..");
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "storage.googleapis.com" &&
      /^\/[A-Za-z0-9._-]+\/theme-releases\//.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The budget: what fits, most visible first.
// ---------------------------------------------------------------------------

export type PersonalizationBudgetItem =
  | { kind: "page"; pageSlug: string; credits: number }
  | { kind: "design"; credits: number }
  | { kind: "chrome"; credits: number }
  | { kind: "category"; index: number; credits: number }
  | { kind: "photo"; ref: string; credits: number };

export interface PersonalizationBudgetPlan {
  included: PersonalizationBudgetItem[];
  /** Left out because the credits ran out. */
  unaffordable: PersonalizationBudgetItem[];
  /** Photos left out because one proposal draws at most this many. */
  overPhotoLimit: string[];
  credits: number;
}

/**
 * The order things are bought in, and what fits.
 *
 * ★ THE HOMEPAGE'S WORDS FIRST, THEN THE LOOK, THEN THE PHOTOS IN THE ORDER
 *   A SHOPPER SEES THEM, then the other pages. "Mink replaces the most
 *   visible photos first and says when the balance runs out" (owner,
 *   2026-10-20): the homepage hero is the first thing anyone sees, an About
 *   page's third picture the last. An item that does not fit is skipped and
 *   the cheaper ones after it still get their chance.
 *
 * `remaining` is the store's credits (null for an unmetered plan).
 */
export function planPersonalizationBudget(input: {
  remaining: number | null;
  pages: readonly string[];
  design: boolean;
  chrome: boolean;
  categoryCount: number;
  photos: readonly PersonalizationPhotoRef[];
  maxPhotos?: number;
  /** Buy photos alone, most visible first: nothing else is written. */
  photosOnly?: boolean;
}): PersonalizationBudgetPlan {
  const maxPhotos = input.maxPhotos ?? MINK_PERSONALIZATION_MAX_PHOTOS;
  const sortedPhotos = [...input.photos].sort(comparePhotos);
  const homePhotos = sortedPhotos.filter((photo) => photo.pageSlug === "home");
  const queue: PersonalizationBudgetItem[] = [];
  const pageItem = (pageSlug: string): PersonalizationBudgetItem => ({
    kind: "page",
    pageSlug,
    credits: MINK_PERSONALIZATION_PRICES.page,
  });
  const photoItem = (
    photo: PersonalizationPhotoRef,
  ): PersonalizationBudgetItem => ({
    kind: "photo",
    ref: photo.ref,
    credits: MINK_PERSONALIZATION_PRICES.photo,
  });
  if (input.photosOnly) {
    for (const photo of sortedPhotos) queue.push(photoItem(photo));
  } else {
    if (input.pages.includes("home")) queue.push(pageItem("home"));
    if (input.design) {
      queue.push({
        kind: "design",
        credits: MINK_PERSONALIZATION_PRICES.design,
      });
    }
    if (input.chrome) {
      queue.push({
        kind: "chrome",
        credits: MINK_PERSONALIZATION_PRICES.chrome,
      });
    }
    for (let index = 0; index < input.categoryCount; index++) {
      queue.push({
        kind: "category",
        index,
        credits: MINK_PERSONALIZATION_PRICES.category,
      });
    }
    for (const photo of homePhotos) queue.push(photoItem(photo));
    for (const pageSlug of input.pages) {
      if (pageSlug === "home") continue;
      queue.push(pageItem(pageSlug));
      for (const photo of sortedPhotos) {
        if (photo.pageSlug === pageSlug) queue.push(photoItem(photo));
      }
    }
  }

  const included: PersonalizationBudgetItem[] = [];
  const unaffordable: PersonalizationBudgetItem[] = [];
  const overPhotoLimit: string[] = [];
  let credits = 0;
  let photos = 0;
  for (const item of queue) {
    if (item.kind === "photo" && photos >= maxPhotos) {
      overPhotoLimit.push(item.ref);
      continue;
    }
    if (input.remaining !== null && credits + item.credits > input.remaining) {
      unaffordable.push(item);
      continue;
    }
    included.push(item);
    credits += item.credits;
    if (item.kind === "photo") photos += 1;
  }
  return { included, unaffordable, overPhotoLimit, credits };
}

/** Most visible first: the homepage, then prominence, then page order. */
export function comparePhotos(
  a: PersonalizationPhotoRef,
  b: PersonalizationPhotoRef,
): number {
  const home = Number(b.pageSlug === "home") - Number(a.pageSlug === "home");
  if (home !== 0) return home;
  if (a.pageSlug !== b.pageSlug) return a.order - b.order;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.order - b.order;
}

// ---------------------------------------------------------------------------
// Applying the writer's answer to a page.
// ---------------------------------------------------------------------------

export interface PersonalizationTextEdit {
  ref: string;
  value: string;
}

export interface PersonalizationListEdit {
  ref: string;
  items: Array<Record<string, string>> | string[];
}

export interface PersonalizationPhotoEdit {
  ref: string;
  url: string;
  alt: string;
}

export interface PersonalizationPageResult {
  sections: PageSectionItem[];
  changedSectionIds: string[];
  hiddenSectionIds: string[];
  textChanges: number;
  photoChanges: number;
}

/**
 * The page with the edits applied. Every edit is matched to the inventory by
 * its ref, so a path the inventory did not offer can never be written.
 *
 * `toHtml` turns a rich field's prose into HTML; it is injected so this file
 * stays free of the sanitiser.
 */
export function applyPersonalizationToPage(input: {
  sections: readonly PageSectionItem[];
  inventory: PersonalizationPageInventory;
  texts: ReadonlyMap<string, string>;
  lists: ReadonlyMap<string, PersonalizationListEdit["items"]>;
  photos: ReadonlyMap<string, { url: string; alt: string }>;
  toHtml: (prose: string) => string;
}): PersonalizationPageResult {
  const sections = structuredClone(input.sections) as PageSectionItem[];
  const byId = new Map(sections.map((section) => [section.id, section]));
  const changed = new Set<string>();
  const hiddenIds: string[] = [];
  let textChanges = 0;
  let photoChanges = 0;

  for (const ref of input.inventory.texts) {
    const value = input.texts.get(ref.ref);
    if (value === undefined) continue;
    const section = byId.get(ref.sectionId);
    if (!section) continue;
    const next = ref.kind === "rich" ? input.toHtml(value) : value;
    if (!next.trim() && !ref.optional) continue;
    if (writeAt(asRecord(section.config), ref.path, next, ref.current)) {
      changed.add(section.id);
      textChanges += 1;
    }
  }

  for (const ref of input.inventory.lists) {
    const items = input.lists.get(ref.ref);
    if (!items) continue;
    const section = byId.get(ref.sectionId);
    if (!section) continue;
    const config = asRecord(section.config);
    if (items.length === 0) {
      // ★ NOTHING TRUE TO SAY IS A HIDDEN SECTION, not an empty one: an
      //   empty trust bar or ticker fails the publish bar, and the theme's
      //   claims are exactly what is being taken down.
      if (section.enabled) {
        section.enabled = false;
        hiddenIds.push(section.id);
        changed.add(section.id);
      }
      continue;
    }
    config[ref.key] = listValue(ref, config[ref.key], items);
    changed.add(section.id);
    textChanges += items.length;
  }

  for (const ref of input.inventory.photos) {
    const photo = input.photos.get(ref.ref);
    if (!photo) continue;
    const section = byId.get(ref.sectionId);
    if (!section) continue;
    const config = asRecord(section.config);
    if (!writeAt(config, ref.path, photo.url, ref.current)) continue;
    if (ref.altPath) writeAt(config, ref.altPath, photo.alt, null);
    for (const clear of ref.clears) deleteAt(config, clear);
    changed.add(section.id);
    photoChanges += 1;
  }

  for (const hiddenSection of input.inventory.hidden) {
    const section = byId.get(hiddenSection.sectionId);
    if (!section || !section.enabled) continue;
    section.enabled = false;
    hiddenIds.push(section.id);
    changed.add(section.id);
  }

  return {
    sections,
    changedSectionIds: [...changed],
    hiddenSectionIds: hiddenIds,
    textChanges,
    photoChanges,
  };
}

function listValue(
  ref: PersonalizationListRef,
  existing: unknown,
  items: PersonalizationListEdit["items"],
): unknown[] {
  const previous = Array.isArray(existing) ? existing : [];
  if (ref.kind === "ticker") {
    return (items as unknown[])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.slice(0, TICKER_MESSAGE_MAX_CHARS));
  }
  return (items as Array<Record<string, string>>).map((item, index) => {
    const base = asRecord(previous[index] ?? previous[0] ?? {});
    if (ref.kind === "usp") {
      const icon = (USP_ICONS as readonly string[]).includes(item.icon)
        ? (item.icon as UspIcon)
        : ((base.icon as UspIcon | undefined) ?? "star");
      return {
        ...base,
        icon,
        title: (item.title ?? "").slice(0, 60),
        subtitle: (item.subtitle ?? "").slice(0, 100),
      };
    }
    return {
      ...base,
      question: (item.question ?? "").slice(0, 180),
      answer: (item.answer ?? "").slice(0, Math.min(600, FAQ_ANSWER_MAX_CHARS)),
      category: typeof base.category === "string" ? base.category : "",
    };
  });
}

/**
 * Write `value` at `path`, but only over a string that is still `expected`
 * (or over any string when `expected` is null). Returns whether it changed.
 */
function writeAt(
  root: Record<string, unknown>,
  path: PersonalizationPath,
  value: string,
  expected: string | null,
): boolean {
  const parent = parentAt(root, path);
  const key = path[path.length - 1];
  if (!parent || key === undefined) return false;
  const current = (parent as Record<string | number, unknown>)[key];
  if (typeof current !== "string" && expected !== null) return false;
  if (expected !== null && current !== expected) return false;
  if (current === value) return false;
  (parent as Record<string | number, unknown>)[key] = value;
  return true;
}

function deleteAt(root: Record<string, unknown>, path: PersonalizationPath) {
  const parent = parentAt(root, path);
  const key = path[path.length - 1];
  if (!parent || key === undefined || Array.isArray(parent)) return;
  delete (parent as Record<string, unknown>)[String(key)];
}

function parentAt(
  root: Record<string, unknown>,
  path: PersonalizationPath,
): Record<string, unknown> | unknown[] | null {
  let node: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(node) && typeof segment === "number")
      node = node[segment];
    else if (node && typeof node === "object" && typeof segment === "string")
      node = (node as Record<string, unknown>)[segment];
    else return null;
    if (!node || typeof node !== "object") return null;
  }
  return node as Record<string, unknown> | unknown[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringFields(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tool's input: the merchant's answers, the look and the confirmed
// category changes.
// ---------------------------------------------------------------------------

export interface PersonalizationBrief {
  businessName: string;
  whatYouSell: string;
  lookAndFeel: string;
  audience: string;
  tone: string;
  story: string;
  facts: string[];
  avoid: string;
  photoDirection: string;
  /** "English" unless the merchant asked for another language. */
  language: string;
}

export type PersonalizationCategoryChange =
  | {
      action: "update";
      slug: string;
      name: string | null;
      description: string | null;
      newPhoto: boolean;
    }
  | {
      action: "create";
      name: string;
      slug: string | null;
      description: string | null;
      newPhoto: boolean;
    }
  | { action: "hide"; slug: string };

export interface PersonalizationRequest {
  brief: PersonalizationBrief;
  pages: string[] | null;
  design: {
    expectedDesignDigest: string;
    palette: unknown;
    fonts: unknown;
    shape: unknown;
  } | null;
  categories: PersonalizationCategoryChange[];
  unpublishSampleProducts: boolean;
  /**
   * Only new photos for the theme photos still on the chosen pages: no text,
   * look, header, category or product change. "Make the rest of the photos"
   * after a personalisation that ran into the photo limit.
   */
  photosOnly: boolean;
  explanation: string;
}

const BRIEF_LIMITS = {
  businessName: 120,
  whatYouSell: 600,
  lookAndFeel: 400,
  audience: 300,
  tone: 200,
  story: 1_200,
  fact: 200,
  facts: 15,
  avoid: 300,
  photoDirection: 500,
  language: 40,
};

/**
 * The tool's arguments, checked and normalised. Returns every problem at
 * once so one retry can fix them all.
 */
export function readPersonalizationRequest(
  input: Record<string, unknown>,
):
  | { ok: true; value: PersonalizationRequest }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const brief = asRecord(input.brief);
  const text = (
    value: unknown,
    label: string,
    max: number,
    required = false,
  ): string => {
    const normalized =
      typeof value === "string" ? value.normalize("NFKC").trim() : "";
    if (required && normalized.length < 3) {
      issues.push(`${label} is required: ask the merchant if you do not know.`);
    }
    if (normalized.length > max) {
      issues.push(`${label} must be ${max} characters or fewer.`);
    }
    return normalized.slice(0, max);
  };
  const facts = Array.isArray(brief.facts)
    ? brief.facts
        .filter((fact): fact is string => typeof fact === "string")
        .map((fact) => fact.normalize("NFKC").trim())
        .filter(Boolean)
    : [];
  if (facts.length > BRIEF_LIMITS.facts) {
    issues.push(`brief.facts holds at most ${BRIEF_LIMITS.facts} statements.`);
  }
  if (facts.some((fact) => fact.length > BRIEF_LIMITS.fact)) {
    issues.push(
      `Each of brief.facts must be ${BRIEF_LIMITS.fact} characters or fewer.`,
    );
  }
  const value: PersonalizationRequest = {
    brief: {
      businessName: text(
        brief.business_name,
        "brief.business_name",
        BRIEF_LIMITS.businessName,
      ),
      whatYouSell: text(
        brief.what_you_sell,
        "brief.what_you_sell (what the store sells)",
        BRIEF_LIMITS.whatYouSell,
        true,
      ),
      lookAndFeel: text(
        brief.look_and_feel,
        "brief.look_and_feel (how the merchant wants the store to look)",
        BRIEF_LIMITS.lookAndFeel,
        true,
      ),
      audience: text(brief.audience, "brief.audience", BRIEF_LIMITS.audience),
      tone: text(brief.tone, "brief.tone", BRIEF_LIMITS.tone),
      story: text(brief.story, "brief.story", BRIEF_LIMITS.story),
      facts: facts.slice(0, BRIEF_LIMITS.facts),
      avoid: text(brief.avoid, "brief.avoid", BRIEF_LIMITS.avoid),
      photoDirection: text(
        input.photo_direction,
        "photo_direction",
        BRIEF_LIMITS.photoDirection,
      ),
      language:
        text(brief.language, "brief.language", BRIEF_LIMITS.language) ||
        "English",
    },
    pages: null,
    design: null,
    categories: [],
    unpublishSampleProducts: input.unpublish_sample_products === true,
    photosOnly: input.photos_only === true,
    explanation: text(input.explanation, "explanation", 1_000, true),
  };

  if (input.pages !== undefined && input.pages !== null) {
    if (
      !Array.isArray(input.pages) ||
      input.pages.some((slug) => typeof slug !== "string")
    ) {
      issues.push("pages must be a list of page slugs, or left out for all.");
    } else {
      const pages = [
        ...new Set(
          (input.pages as string[]).map((slug) => slug.trim().toLowerCase()),
        ),
      ].filter(Boolean);
      if (pages.length > MINK_PERSONALIZATION_MAX_PAGES) {
        issues.push(
          `pages lists at most ${MINK_PERSONALIZATION_MAX_PAGES} pages in one personalisation.`,
        );
      }
      value.pages = pages.slice(0, MINK_PERSONALIZATION_MAX_PAGES);
    }
  }

  if (input.design !== undefined && input.design !== null) {
    const design = asRecord(input.design);
    const digest = design.expected_design_digest;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      issues.push(
        "design.expected_design_digest must be the designDigest from get_storefront_personalization_context.",
      );
    } else {
      value.design = {
        expectedDesignDigest: digest,
        palette: design.palette ?? {},
        fonts: design.fonts ?? {},
        shape: design.shape ?? {},
      };
    }
  }

  if (input.categories !== undefined && input.categories !== null) {
    if (!Array.isArray(input.categories)) {
      issues.push("categories must be a list.");
    } else if (
      input.categories.length > MINK_PERSONALIZATION_MAX_CATEGORY_CHANGES
    ) {
      issues.push(
        `categories holds at most ${MINK_PERSONALIZATION_MAX_CATEGORY_CHANGES} changes.`,
      );
    } else {
      input.categories.forEach((raw, index) => {
        const change = readCategoryChange(asRecord(raw), index, issues);
        if (change) value.categories.push(change);
      });
    }
  }

  if (
    value.photosOnly &&
    (value.design !== null ||
      value.categories.length > 0 ||
      value.unpublishSampleProducts)
  ) {
    issues.push(
      "photos_only makes new photos and changes nothing else: leave design and categories out and set unpublish_sample_products to false.",
    );
  }

  return issues.length ? { ok: false, issues } : { ok: true, value };
}

const CATEGORY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readCategoryChange(
  raw: Record<string, unknown>,
  index: number,
  issues: string[],
): PersonalizationCategoryChange | null {
  const label = `categories[${index}]`;
  const str = (value: unknown, max: number) =>
    typeof value === "string"
      ? value.normalize("NFKC").trim().slice(0, max)
      : "";
  if (raw.merchant_confirmed !== true) {
    issues.push(
      `${label}: ask the merchant before changing a category and set merchant_confirmed only once they have agreed.`,
    );
    return null;
  }
  const slug = str(raw.slug, 80);
  if (raw.action === "hide") {
    if (!CATEGORY_SLUG.test(slug)) {
      issues.push(`${label}: slug must be an existing category's slug.`);
      return null;
    }
    return { action: "hide", slug };
  }
  const name = str(raw.name, 80);
  const description = str(raw.description, 500) || null;
  const newPhoto = raw.new_photo === true;
  if (raw.action === "update") {
    if (!CATEGORY_SLUG.test(slug)) {
      issues.push(`${label}: slug must be an existing category's slug.`);
      return null;
    }
    if (!name && !description && !newPhoto) {
      issues.push(
        `${label}: an update must change the name, description or photo.`,
      );
      return null;
    }
    return {
      action: "update",
      slug,
      name: name || null,
      description,
      newPhoto,
    };
  }
  if (raw.action === "create") {
    if (name.length < 2) {
      issues.push(`${label}: a new category needs a name.`);
      return null;
    }
    if (slug && !CATEGORY_SLUG.test(slug)) {
      issues.push(
        `${label}: slug must use lowercase letters, numbers and hyphens.`,
      );
      return null;
    }
    return {
      action: "create",
      name,
      slug: slug || null,
      description,
      newPhoto,
    };
  }
  issues.push(`${label}: action must be update, create or hide.`);
  return null;
}

/** A category's address, from its name, the way the category editor makes one. */
export function categorySlugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// The stored proposal: everything the approval writes, and nothing it
// re-derives. Bound by a digest the approval carries.
// ---------------------------------------------------------------------------

export interface PersonalizationStoredPage {
  pageId: string;
  slug: string;
  title: string;
  expectedVersion: string;
  expectedDigest: string;
  sections: PageSectionItem[];
  proposedDigest: string;
  textChanges: number;
  photoChanges: number;
  hidden: Array<{ sectionId: string; type: string; reason: string }>;
}

export interface PersonalizationStoredChrome {
  expectedTextDigest: string;
  expectedDesignDigest: string;
  /** Null: the design stays as it is. */
  design: import("@/lib/chrome/design").StorefrontDesignOverrides | null;
  /** Null: the announcement stays as it is. */
  announcementText: string | null;
  /** Null: the newsletter block stays as it is. */
  newsletter: { heading: string; subtext: string; buttonLabel: string } | null;
}

export interface PersonalizationStoredBrand {
  expectedDigest: string;
  /** Null: unchanged. */
  tagline: string | null;
  blurb: string | null;
}

export type PersonalizationStoredCategory =
  | {
      action: "update";
      id: string;
      slug: string;
      expectedUpdatedAt: string;
      before: {
        name: string;
        description: string | null;
        imageUrl: string | null;
      };
      name: string;
      description: string | null;
      imageUrl: string | null;
    }
  | {
      action: "create";
      slug: string;
      name: string;
      description: string | null;
      imageUrl: string | null;
    }
  | {
      action: "hide";
      id: string;
      slug: string;
      expectedUpdatedAt: string;
      name: string;
    };

export interface PersonalizationStoredProduct {
  id: string;
  name: string;
  expectedUpdatedAt: string;
}

export interface PersonalizationStoredPhoto {
  url: string;
  path: string;
  alt: string;
  where: string;
}

export interface PersonalizationCreditBreakdown {
  pages: number;
  photos: number;
  design: number;
  chrome: number;
  categories: number;
  total: number;
}

export interface PersonalizationStoredPlan {
  schemaVersion: typeof MINK_PERSONALIZATION_SCHEMA_VERSION;
  pages: PersonalizationStoredPage[];
  chrome: PersonalizationStoredChrome | null;
  brand: PersonalizationStoredBrand | null;
  categories: PersonalizationStoredCategory[];
  products: PersonalizationStoredProduct[];
  photos: PersonalizationStoredPhoto[];
  skipped: Array<{ label: string; reason: string }>;
  explanation: string;
  credits: PersonalizationCreditBreakdown;
}

/** What the approval changes on the live store at once, in the merchant's words. */
export function personalizationLiveChanges(
  plan: Pick<PersonalizationStoredPlan, "categories" | "products" | "brand">,
): string[] {
  const live: string[] = [];
  if (plan.categories.length)
    live.push("Category names, descriptions and photos");
  if (plan.products.length)
    live.push("Theme sample products taken off the shop");
  if (
    plan.brand &&
    (plan.brand.tagline !== null || plan.brand.blurb !== null)
  ) {
    live.push("Your store's tagline and footer description");
  }
  return live;
}
