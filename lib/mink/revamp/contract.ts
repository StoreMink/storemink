// ---------------------------------------------------------------------------
// Mink storefront revamp: the shared contract, with no I/O.
//
// "Customise my store for my business" rebuilds what shoppers see in one
// background job and one review card (docs/mink-storefront-revamp.md). Every
// module of the revamp imports its types from here, so the job, the runner,
// the tools, the apply path and the card agree on what a revamp IS.
//
// ★ PURE AND CLIENT-SAFE: the card renders from these types and labels, so
//   nothing here may import a server module, a database client or Node APIs.
//
// ★★ THE CARD'S DRAFT IS A PERSONALISATION DRAFT, PLAN VERSION 2. The draft
//   kind stays `storefront_personalization` and the approval stays
//   `apply_storefront_personalization`, so every vocabulary, approval and
//   audit check that migration 0232 installed is reused; `schemaVersion: 2`
//   is what tells the apply path it holds a revamp.
// ---------------------------------------------------------------------------

import type { PageSectionItem } from "@/lib/sections/registry";
import type {
  FooterGroup,
  StoreChrome,
  StorefrontAppearance,
} from "@/lib/chrome/types";
import type { StorefrontDesignOverrides } from "@/lib/chrome/design";
import type { NavLink } from "@/lib/chrome/nav";
import type { ProductOption } from "@/lib/products/options";
import type { ThemeIndustry } from "@/lib/themes/meta";
import type {
  PersonalizationCategoryChange,
  PersonalizationStoredBrand,
  PersonalizationStoredCategory,
  PersonalizationStoredPhoto,
  PersonalizationStoredProduct,
} from "../storefront-personalization-contract";
// A type-only import, erased at compile, so this module stays client-safe
// while the facts keep ONE definition beside the reader that fills them.
import type { PersonalizationFacts } from "../storefront-personalization-context";
import { MINK_PERSONALIZATION_PRICES } from "../storefront-personalization-contract";
import type { RevampUndoResult } from "./lifecycle-types";

export const REVAMP_SCHEMA_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// The job's vocabulary.
// ---------------------------------------------------------------------------

export const REVAMP_STATUSES = [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type RevampStatus = (typeof REVAMP_STATUSES)[number];

/** A job that is still building. One per store at a time. */
export const ACTIVE_REVAMP_STATUSES: readonly RevampStatus[] = [
  "queued",
  "running",
];

/**
 * A finished version of a redesign: ready, or replaced by a newer version
 * after it was applied (it keeps its review, Publish and Undo).
 */
export function isFinishedRevampVersion(entry: {
  status: RevampStatus;
  appliedAt: string | null;
}): boolean {
  return (
    entry.status === "ready" ||
    (entry.status === "superseded" && entry.appliedAt !== null)
  );
}

/**
 * ★ A redesign a refinement builds on by default: a finished version that
 * was not undone. One rule for the chat's routing and for the refinement
 * tool, so the route never offers only a refinement the tool then refuses.
 */
export function isRefinableRevamp(entry: {
  status: RevampStatus;
  appliedAt: string | null;
  undoneAt: string | null;
}): boolean {
  return !entry.undoneAt && isFinishedRevampVersion(entry);
}

/**
 * ★★ A REDESIGN'S STATE IN WORDS A MERCHANT CAN BE TOLD, never the job's own
 *   status: the model recited "status queued" and "superseded" to a merchant
 *   on 25 Oct 2026. One map for the redesign tools and the chat's per-turn
 *   reference, so the two never describe one redesign differently.
 */
export const REVAMP_STATE_WORDS: Record<RevampStatus, string> = {
  queued: "being made",
  running: "being made",
  ready: "ready to review",
  superseded: "replaced by a newer version",
  failed: "did not finish",
  cancelled: "stopped",
};

/** See REVAMP_STATE_WORDS; an active redesign asked to stop is "stopping". */
export function revampStateWord(entry: {
  status: RevampStatus;
  cancelRequested: boolean;
}): string {
  return entry.cancelRequested && ACTIVE_REVAMP_STATUSES.includes(entry.status)
    ? "stopping"
    : REVAMP_STATE_WORDS[entry.status];
}

export const REVAMP_KINDS = ["full", "refine"] as const;
export type RevampKind = (typeof REVAMP_KINDS)[number];

/** The steps, in the order the runner takes them. */
export const REVAMP_STEPS = [
  "snapshot",
  "plan",
  "compile",
  "photos",
  "products",
  "assemble",
  "checks",
  "card",
] as const;
export type RevampStep = (typeof REVAMP_STEPS)[number];

/** What the card says while each step runs, in the merchant's words. */
export const REVAMP_STEP_LABELS: Record<RevampStep, string> = {
  snapshot: "Reading your store",
  plan: "Designing your store",
  compile: "Writing every page",
  photos: "Taking new photographs",
  products: "Photographing your products",
  assemble: "Putting the pages together",
  checks: "Checking every page on phone and desktop",
  card: "Getting your review ready",
};

export type RevampStepState = "waiting" | "running" | "done" | "skipped";

export interface RevampProgressItem {
  step: RevampStep;
  state: RevampStepState;
  /** A short count the card shows beside the label, e.g. "7 of 24". */
  detail: string | null;
}

/** The progress list a new job starts with. */
export function initialRevampProgress(): RevampProgressItem[] {
  return REVAMP_STEPS.map((step) => ({ step, state: "waiting", detail: null }));
}

/**
 * Closed codes a failed job may carry. The card turns each into a sentence;
 * the raw detail is logged, never shown.
 */
export const REVAMP_ERROR_CODES = [
  "model_unavailable",
  "model_refused",
  "plan_invalid",
  // ★ A step throws it only as a wait, so no job ends with it today: each
  //   permanent photo failure has the code whose sentence is true for it
  //   (photos.ts `anchorFailureError`).
  "photos_unavailable",
  // ★ The new photographs did not pass their checks and none was left to
  //   stand in (photos.ts `nothingToCropFrom`), or the anchor failed its
  //   check after every redraw, which no wait fixes.
  "photos_failed",
  "store_changed",
  "theme_missing",
  "not_allowed",
  "out_of_attempts",
  "limit_reached",
  "cancelled",
  "internal",
  // ★ The store's balance fell below what the card costs while it was being
  //   made (runner.ts checks before any photograph; card.ts at the charge).
  "out_of_credits",
] as const;
export type RevampErrorCode = (typeof REVAMP_ERROR_CODES)[number];

export const REVAMP_ERROR_MESSAGES: Record<RevampErrorCode, string> = {
  model_unavailable:
    "Mink AI could not reach its design model for long enough to finish. Nothing was changed. Ask Mink to try again in a few minutes.",
  model_refused:
    "The design model declined part of this request. Nothing was changed. Try describing the store a little differently.",
  plan_invalid:
    "Mink AI could not put together pages that pass its own checks this time. Nothing was changed. Ask Mink to try again.",
  photos_unavailable:
    "The photo service was too busy to finish the new photographs. Nothing was changed. Ask Mink to try again in a few minutes.",
  photos_failed:
    "The new photographs did not pass Mink AI's own checks this time. Nothing was changed. Ask Mink to try again.",
  store_changed:
    "Your store changed while Mink AI was working on it. Nothing was changed. Ask Mink to start again from the store as it is now.",
  theme_missing:
    "Your store needs a theme before Mink AI can redesign it. Choose one under Online store, Storefront.",
  not_allowed:
    "Your role cannot change the Website Builder, so Mink AI stopped. Ask the store owner.",
  out_of_attempts:
    "Mink AI tried several times and could not finish. Nothing was changed. Ask Mink to try again later.",
  limit_reached:
    "Your store has made as many new photographs today as Mink AI allows, so this redesign stopped. Nothing was changed. Ask Mink again tomorrow.",
  cancelled: "You stopped this redesign. Nothing was changed.",
  internal:
    "Something went wrong while Mink AI was working. Nothing was changed. Ask Mink to try again.",
  // ★ No figure (owner's rule): what the store has left is on Plans & Billing.
  out_of_credits:
    "This store ran out of Mink credits while the redesign was being made, so it stopped. Nothing was changed. Buy Mink credits or upgrade under Plans & Billing, then ask Mink again.",
};

// ---------------------------------------------------------------------------
// Limits and prices.
// ---------------------------------------------------------------------------

export const REVAMP_LIMITS = {
  /** Photographs one revamp may draw (the anchor not counted). */
  maxShots: 26,
  /** The merchant's own products one revamp may create. */
  maxProducts: 20,
  /** Sizes (variants) per product. */
  maxSizes: 8,
  /** Pages one revamp may write, the homepage included. */
  maxPages: 10,
  /** Category changes one revamp may make (merchant-confirmed only). */
  maxCategoryChanges: 12,
  /** Refinements that may build on one revamp. */
  maxRefinements: 10,
  /**
   * Revamps (full or refine) started per store per day; a failed one gives
   * its start back (B5, jobs.ts revampStartLimit).
   */
  startsPerStorePerDay: 6,
  /** Revamp photos per store per day, claimed per photo as it is drawn. */
  photosPerStorePerDay: 120,
  /** Revamp photos across the platform per hour. */
  platformPhotosPerHour: 400,
  /** How long one runner invocation may work before it hands over. */
  runnerDeadlineMs: 18 * 60_000,
  /**
   * How long a step may drain after the deadline before it is stopped (the
   * hard stop, runner.ts REVAMP_DEADLINE_GRACE_MS). The route runs for 1,200
   * seconds, so 18 minutes and this still leave half a minute to hand over.
   */
  deadlineGraceMs: 90_000,
  /**
   * ★★ The least room left before the hard stop when an image call ends on
   *   its own clock (D2): a shoot photo, a photo check or a studio photo is
   *   admitted only while its whole per-try clock and this margin fit before
   *   the hard stop (photos.ts `revampAdmissionDrain`). The planner and its
   *   repairs are not held to it yet (runner.ts REVAMP_DEADLINE_GRACE_MS).
   */
  hardStopMarginMs: 5_000,
  /** The runner's lease, renewed while it works. */
  leaseMs: 5 * 60_000,
  leaseRenewMs: 60_000,
  /**
   * A step's real failures in a row before the job fails for good (B8: a
   * claim, a wait on Google and a claim whose process died count none;
   * jobs.ts REVAMP_RUN_CEILING_MS bounds the rest).
   */
  maxAttempts: 4,
  /** The fewest milliseconds between two kicks of one job from a status poll. */
  kickCooldownMs: 30_000,
  /** The highest charge one revamp card may carry (the draft ceiling). */
  maxCredits: 200,
} as const;

/**
 * Today's prices (owner, 2026-10-20 and 2026-10-21), read from the draft
 * table so they cannot drift from what single proposals cost. ★ The first
 * full revamp of every store is free (owner, 2026-10-21): `free` on the job.
 * ★ Never shown on the dashboard (rule: no credit prices on the dashboard).
 */
export const REVAMP_PRICES = {
  page: MINK_PERSONALIZATION_PRICES.page,
  photo: MINK_PERSONALIZATION_PRICES.photo,
  design: MINK_PERSONALIZATION_PRICES.design,
  chrome: MINK_PERSONALIZATION_PRICES.chrome,
  category: MINK_PERSONALIZATION_PRICES.category,
  /** A studio photo of a merchant's product, made from their own photo. */
  productPhoto: 5,
} as const;

/** Page slugs a revamp never writes: the merchant's legal text. */
export const REVAMP_SKIPPED_SLUGS: ReadonlySet<string> = new Set([
  "terms",
  "refund-policy",
  "shipping-policy",
  "privacy-policy",
]);

/** Image fields in a planned section name a shot with this prefix. */
export const REVAMP_SLOT_PREFIX = "revamp-slot://";

// ---------------------------------------------------------------------------
// The merchant's request, as the tools pass it to the job.
// ---------------------------------------------------------------------------

export interface RevampBrief {
  /** What the store sells and who buys it, in the merchant's words. */
  business: string;
  /** The look and feeling the merchant wants. "" when not given. */
  look: string;
  /** Who the customers are. "" when not given. */
  audience: string;
  /** Real facts the copy may state: the facility, the process, the year. */
  facts: string[];
  /** What the merchant does not want. */
  avoid: string;
  /**
   * "English" unless the merchant insisted on another language after Mink
   * reminded them once (owner's rule: drafts in English).
   */
  language: string;
}

export interface RevampProductSize {
  /** "" for a product sold in one size only. */
  label: string;
  /** The selling price in rupees. */
  price: number;
  /** The MRP, when the merchant gave one above the price. */
  mrp: number | null;
}

/** One of the merchant's own products. Never invented (owner's rule). */
export interface RevampProductInput {
  /** Stable within the revamp: "p1", "p2", … */
  key: string;
  name: string;
  /** The merchant's own words; the copy may polish but not add claims. */
  description: string;
  sizes: RevampProductSize[];
  /** An image the store owns (a chat attachment saved to Media), or null. */
  photoUrl: string | null;
  /** A category slug that exists or that a confirmed change creates. */
  categorySlug: string | null;
}

/** What a refinement may change. Everything else is carried over. */
export interface RevampRefineScope {
  design: boolean;
  copy: boolean;
  layout: boolean;
  /** Shot ids to redraw, "all", or none. */
  photos: string[] | "all" | null;
  /** Page slugs the refinement is about, or null for all. */
  pages: string[] | null;
  products: boolean;
}

export interface RevampRequest {
  kind: RevampKind;
  brief: RevampBrief;
  products: RevampProductInput[];
  /** Category changes the merchant agreed to, each one. */
  categories: PersonalizationCategoryChange[];
  /** Pages the merchant named; null is the default scope (section 9). */
  pages: string[] | null;
  /** The merchant's words for a refinement ("make it warmer"). */
  instruction: string | null;
  refineScope: RevampRefineScope | null;
}

// ---------------------------------------------------------------------------
// The store as the runner read it.
// ---------------------------------------------------------------------------

export type RevampOwner = "theme" | "mink" | "merchant";

export interface RevampSnapshotPage {
  id: string;
  /** "" for the homepage, else the stored slug. */
  slug: string;
  title: string;
  status: string;
  /** The page's `updated_at`, full precision: the apply path's version. */
  version: string;
  /** Digest of the draft section list the plan is written against. */
  sectionsDigest: string;
  sections: PageSectionItem[];
  /** Who wrote each section, by id. */
  owners: Record<string, RevampOwner>;
  /** A policy page or a page that cannot be read: never written. */
  skipped: "policy" | "invalid" | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface RevampSnapshotCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  status: string;
  updatedAt: string;
  sample: boolean;
  productCount: number;
}

export interface RevampSnapshotProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
  updatedAt: string;
  sample: boolean;
  imageUrl: string | null;
  categoryId: string | null;
  /**
   * products.featured, which a featured_products band set to "featured"
   * reads. ★ Absent (a snapshot read before it was carried) counts as not
   * featured, so a band names the products instead of hoping (output-5).
   */
  featured?: boolean;
}

export interface RevampThemeInfo {
  id: string;
  version: string | null;
  name: string;
  /** The theme's own colours, as #rrggbb, for the planner and the photos. */
  palette: {
    page: string;
    surface: string;
    ink: string;
    accent: string;
  };
  /** The theme's own layout choices (header, card, footer variants). */
  layout: Record<string, string | null>;
  /**
   * The theme's own announcement line, which the storefront shows on a bar
   * left on with no text (lib/themes/announcement.ts): null when the theme
   * has none. Absent on a snapshot stored before it was read (output-2).
   */
  announcement?: { text: string; href: string } | null;
}

export interface RevampSnapshot {
  storeId: string;
  storeName: string;
  storeSlug: string;
  launched: boolean;
  theme: RevampThemeInfo;
  pages: RevampSnapshotPage[];
  chrome: {
    rowExists: boolean;
    /** The chrome row's `updated_at`, or null with no row. */
    version: string | null;
    /** Digest of the whole chrome draft: the apply path's lock. */
    digest: string;
    value: StoreChrome;
  };
  brand: {
    tagline: string | null;
    blurb: string | null;
    digest: string;
  };
  categories: RevampSnapshotCategory[];
  products: RevampSnapshotProduct[];
  facts: PersonalizationFacts & {
    city: string | null;
    state: string | null;
  };
  photos: {
    /** Image URLs a revamp may replace: theme files, earlier Mink photos, broken. */
    replaceable: string[];
    /** Image URLs that no longer load. */
    broken: string[];
    /**
     * ★★ The product photos (the request's and the store's own products')
     * that are objects under this store's own prefix in our bucket: the only
     * ones the photos step can read as a reference (`readStoreOwnedImageBytes`),
     * so the only ones a shot of the merchant's goods may name (B16,
     * `revampGoodsCatalogue`). Absent on a snapshot read before it was
     * carried, which reads a photo as readable when its address names this
     * store's own folder.
     */
    readable?: string[];
  };
  entitlements: { customCode: boolean };
}

// ---------------------------------------------------------------------------
// The site plan: the model's design, compiled and validated.
// ---------------------------------------------------------------------------

export const REVAMP_SHOT_PURPOSES = ["hero", "content", "category"] as const;
export type RevampShotPurpose = (typeof REVAMP_SHOT_PURPOSES)[number];

/**
 * ★★ REAL GOODS OR NO GOODS (owner's decision B16, 2026-10-23). A redesign's
 * banner, content and category photographs show the merchant's own products,
 * drawn from their own product photos ("merchant"), or a scene with no
 * products in it at all ("none"): a setting, materials, ingredients, or a
 * still life of props that are not products. Never invented goods. Theme
 * Studio's demo themes keep their fictional goods; this rule is the
 * redesign's alone.
 */
export const REVAMP_SHOT_GOODS = ["merchant", "none"] as const;
export type RevampShotGoods = (typeof REVAMP_SHOT_GOODS)[number];

/** The most products one shot may show. */
export const REVAMP_SHOT_MAX_PRODUCT_KEYS = 2;

export interface RevampShot {
  id: string;
  purpose: RevampShotPurpose;
  subject: string;
  artDirection: string;
  /** One of the image model's ratios ("21:9", "4:5", "1:1", "4:3", …). */
  aspectRatio: string;
  people: "none" | "adults";
  /**
   * What the photograph shows (REVAMP_SHOT_GOODS). The compiler always
   * writes it; absent on a plan compiled before prompt v5, which reads as
   * "none" (revampShotGoods).
   */
  goods?: RevampShotGoods;
  /**
   * With goods "merchant": one or two products the shot shows, each by its
   * goods key (a request product's own key, "p1", or "shop:<slug>" for a
   * product the store already sells), only products with their own photo,
   * only this store's. Empty with goods "none". Resolve a key to its photo
   * with `revampGoodsCatalogue` (site-compiler.ts), the rule the compiler
   * validated it with.
   */
  productKeys?: string[];
}

/**
 * A shot's goods as the photos step should read them: absent fields (a plan
 * compiled before prompt v5) are a scene with no products, and "merchant"
 * with no key left is one too, never invented goods.
 */
export function revampShotGoods(
  shot: Pick<RevampShot, "goods" | "productKeys">,
): { goods: RevampShotGoods; productKeys: string[] } {
  const keys = Array.isArray(shot.productKeys)
    ? shot.productKeys
        .filter((key): key is string => typeof key === "string" && key !== "")
        .slice(0, REVAMP_SHOT_MAX_PRODUCT_KEYS)
    : [];
  if (shot.goods === "merchant" && keys.length > 0) {
    return { goods: "merchant", productKeys: keys };
  }
  return { goods: "none", productKeys: [] };
}

/** Where a shot's photograph goes: one field of one section of one page. */
export interface RevampSlotBinding {
  shotId: string;
  pageSlug: string;
  sectionId: string;
  /** Path to the `*_url` field inside the section's config. */
  path: Array<string | number>;
  /** The crop the stored image must end at. */
  frame: { width: number; height: number; aspect: number };
  /** Set when the slot also takes a phone crop of the same photo. */
  phonePath: Array<string | number> | null;
}

export interface RevampPlannedPage {
  slug: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  /** True for a page the store does not have yet (created as a draft). */
  create: boolean;
  /** The existing page's id, null for a new one. */
  pageId: string | null;
  /** Image fields may still hold `revamp-slot://` until assembly. */
  sections: PageSectionItem[];
}

export interface RevampSitePlan {
  summary: string;
  industry: ThemeIndustry;
  direction: string;
  design: StorefrontDesignOverrides;
  appearance: Partial<
    Pick<StorefrontAppearance, "header" | "card" | "productDetail" | "footer">
  >;
  announcement: { text: string; href: string };
  brand: { tagline: string; blurb: string };
  newsletter: { heading: string; subtext: string; buttonLabel: string };
  pages: RevampPlannedPage[];
  menus: { header: NavLink[]; footerGroups: FooterGroup[] };
  shots: RevampShot[];
  bindings: RevampSlotBinding[];
  /** Polished descriptions of the merchant's products, by product key. */
  productCopy: Record<string, string>;
  notes: string[];
  /**
   * What the plan left out (a paid revamp's budget, a limit), in the
   * merchant's words; shown under "Not done this time".
   */
  skipped: Array<{ label: string; reason: string }>;
  /**
   * What the plan was built from, and what a refinement carries over from
   * the plan it builds on (the compiler fills it). Absent on a plan
   * compiled before it existed, which is charged as it always was.
   */
  basis?: RevampPlanBasis;
}

/**
 * ★ A REFINEMENT IS CHARGED ONLY FOR WHAT IT MAKES (owner's rule: per item,
 * at today's prices). What it carries over unchanged was the parent's work,
 * so it is never charged again and never dropped by the budget.
 */
export interface RevampPlanBasis {
  /** Confirmed category changes in the request the plan was built from. */
  categories: number;
  /**
   * Those changes, one key each ("create:<slug>", "update:<slug>",
   * "hide:<slug>"), so a refinement can tell its parent's changes from its
   * own whichever of them it carries. Absent on an older plan.
   */
  categoryChanges?: string[];
  /** The request's product keys, in order. */
  productKeys: string[];
  /** Request products the store already has by name: never created again. */
  existingProductKeys: string[];
  /** What a refinement carries over unchanged; null on a full revamp. */
  carried: {
    /** Page slugs copied from the previous plan as they were. */
    pages: string[];
    /** Shots whose photograph the parent already has (not redrawn). */
    shots: string[];
    /** The colours, fonts and corners are the parent's. */
    design: boolean;
    /** The menus, layout, announcement, newsletter and brand lines are. */
    chrome: boolean;
    /** How many of the request's category changes the parent already made. */
    categories: number;
    /** Product keys the parent already had. */
    products: string[];
  } | null;
}

// ---------------------------------------------------------------------------
// Photos and products the runner made.
// ---------------------------------------------------------------------------

export type RevampImageRole = "anchor" | "slot" | "product";

export interface RevampStoredImage {
  role: RevampImageRole;
  /** The shot id, the product key, or "anchor". */
  slotId: string;
  url: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
  review: "passed" | "flagged" | "unreviewed";
}

export interface RevampPhotoOutcome {
  shotId: string;
  status: "generated" | "failed" | "skipped";
  /** Why a shot has no photo, in the merchant's words. */
  reason: string | null;
  /**
   * Why its photograph was drawn again, attempt by attempt (P0 diagnostics,
   * never shown to the merchant). Absent when it was drawn once.
   */
  redraws?: RevampRedraw[];
}

/**
 * Why one attempt at a photograph was turned down and drawn again: the
 * problems its check named (THEME_IMAGE_PROBLEMS), or `refused` when the
 * image model declined to draw it. The attempt is the image run's own count
 * (1, 2, 3) in the invocation that drew it.
 */
export interface RevampRedraw {
  attempt: number;
  problems: string[];
}

// ---------------------------------------------------------------------------
// The stored plan (version 2): what the card applies, and nothing it
// re-derives. Bound by a digest the approval carries, like version 1.
// ---------------------------------------------------------------------------

export interface RevampStoredPage {
  /** Null for a page the revamp creates. */
  pageId: string | null;
  slug: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  create: boolean;
  /** The page's version and draft digest the plan was written against. */
  expectedVersion: string | null;
  expectedDigest: string | null;
  sections: PageSectionItem[];
  proposedDigest: string;
  changes: {
    added: number;
    removed: number;
    kept: number;
    photos: number;
  };
}

export interface RevampStoredChrome {
  /** The chrome row's version and whole-draft digest the plan replaces. */
  expectedVersion: string | null;
  expectedDigest: string;
  /** The whole next chrome draft: header, footer, appearance, design. */
  next: StoreChrome;
}

export interface RevampProductVariant {
  name: string;
  optionValues: string[];
  price: number;
  mrp: number | null;
}

export interface RevampStoredProductCreate {
  key: string;
  name: string;
  slug: string;
  description: string;
  categorySlug: string | null;
  /** The studio photo made from the merchant's own photo, or null. */
  imageUrl: string | null;
  /** The merchant's original photo, kept as a second image. */
  sourceImageUrl: string | null;
  options: ProductOption[];
  variants: RevampProductVariant[];
  /** The price a one-size product sells at. */
  price: number;
  mrp: number | null;
}

export interface RevampCheck {
  id: string;
  label: string;
  passed: boolean;
  /** What was fixed or noted, in the merchant's words. */
  note: string | null;
}

export interface RevampCreditBreakdown {
  pages: number;
  photos: number;
  design: number;
  chrome: number;
  categories: number;
  productPhotos: number;
  total: number;
}

export interface RevampStoredPlan {
  schemaVersion: typeof REVAMP_SCHEMA_VERSION;
  revampId: string;
  kind: RevampKind;
  summary: string;
  pages: RevampStoredPage[];
  chrome: RevampStoredChrome | null;
  brand: PersonalizationStoredBrand | null;
  categories: PersonalizationStoredCategory[];
  products: {
    /** Theme sample products taken off the shop. */
    hide: PersonalizationStoredProduct[];
    /** The merchant's own products, created at Apply. */
    create: RevampStoredProductCreate[];
  };
  photos: PersonalizationStoredPhoto[];
  checks: RevampCheck[];
  skipped: Array<{ label: string; reason: string }>;
  notes: string[];
  explanation: string;
  credits: RevampCreditBreakdown;
  free: boolean;
  /**
   * What the charge is for, item by item (assemble.ts fills it, checks.ts
   * recounts it after photos are dropped). Absent on a plan stored before
   * it existed, whose credits stand as they were.
   */
  charges?: RevampChargeBasis;
}

/**
 * ★ THE CARD CHARGES FOR WHAT IT SHOWS. Each line is an item this revamp
 * made: a page it wrote, a photograph drawn now and still on a page, the
 * look, the header and footer, a category change, a studio product photo.
 * What a refinement carried over from its parent is not here.
 */
export interface RevampChargeBasis {
  /** Page slugs written by this revamp. */
  pages: string[];
  /** URLs of photographs drawn in this revamp that a page still shows. */
  photoUrls: string[];
  design: boolean;
  chrome: boolean;
  categories: number;
  /** Product keys whose studio photo this revamp drew and still shows. */
  productPhotoKeys: string[];
}

export function isRevampPlan(plan: unknown): plan is RevampStoredPlan {
  return (
    !!plan &&
    typeof plan === "object" &&
    (plan as { schemaVersion?: unknown }).schemaVersion ===
      REVAMP_SCHEMA_VERSION
  );
}

/**
 * What Apply changes on the live store at once, in the merchant's words: the
 * parts with no draft layer (apply-v2.ts writeRevamp). ★ Page sections and the
 * header and footer go to the draft, and an existing page's title and search
 * text wait for Publish, so none of them is listed; anything added to Apply's
 * live writes must be added here, or the card under-warns before the button.
 */
export function revampLiveChanges(
  plan: Pick<RevampStoredPlan, "categories" | "products" | "brand">,
): string[] {
  const live: string[] = [];
  if (plan.categories.length) live.push("Your categories");
  if (plan.products.create.length)
    live.push(
      plan.products.create.length === 1
        ? "Your product goes on your shop"
        : `Your ${plan.products.create.length} products go on your shop`,
    );
  if (plan.products.hide.length)
    live.push("The theme's sample products are taken off your shop");
  // ★ Only the half the plan rewrites: Apply leaves a null one as it is.
  const tagline = plan.brand?.tagline != null;
  const blurb = plan.brand?.blurb != null;
  if (tagline || blurb)
    live.push(
      tagline && blurb
        ? "Your store's tagline and footer description"
        : tagline
          ? "Your store's tagline"
          : "Your store's footer description",
    );
  return live;
}

/** "1 page", "3 pages": every count the card prints goes through this. */
export function countLabel(
  n: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// What the status route sends the card.
// ---------------------------------------------------------------------------

export interface RevampStatusView {
  id: string;
  kind: RevampKind;
  status: RevampStatus;
  progress: RevampProgressItem[];
  /** The draft the review card applies, once ready. */
  draftId: string | null;
  /** Set when failed: a sentence from REVAMP_ERROR_MESSAGES. */
  error: string | null;
  appliedAt: string | null;
  publishedAt: string | null;
  undoneAt: string | null;
  /** The plan summary for the review card, once ready. */
  review: RevampReview | null;
  /** The revamp that replaced this one, when superseded. */
  supersededBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  /**
   * The requester pressed Stop and it is recorded: a live runner sees it at
   * its next renewal (or right before the card's charge).
   */
  cancelRequested: boolean;
  /** What Undo did, once undone (`apply_snapshot.undo`); null before. */
  undo: RevampUndoResult | null;
}

export interface RevampReviewPage {
  slug: string;
  title: string;
  create: boolean;
  /** The proposed sections, posted to the preview canvas. */
  sections: PageSectionItem[];
  changes: RevampStoredPage["changes"];
}

export interface RevampReview {
  summary: string;
  pages: RevampReviewPage[];
  /** The proposed chrome, posted to the preview canvas. */
  chrome: StoreChrome | null;
  photos: PersonalizationStoredPhoto[];
  products: Array<{
    key: string;
    name: string;
    imageUrl: string | null;
    price: number;
    mrp: number | null;
    categorySlug: string | null;
    sizes: string[];
    /**
     * Each size with the price it goes live at, in the merchant's order;
     * empty for a product sold in one size. ★ Apply publishes every size, so
     * the card shows every price, not only the cheapest.
     */
    sizePrices?: Array<{ label: string; price: number; mrp: number | null }>;
  }>;
  categories: Array<{ action: string; name: string; imageUrl: string | null }>;
  hiddenSampleProducts: number;
  liveChanges: string[];
  checks: RevampCheck[];
  skipped: Array<{ label: string; reason: string }>;
  notes: string[];
  /**
   * What the preview canvas needs to draw the shop as Apply leaves it, for
   * the parts that go live at Apply: every category the plan touches, after
   * the plan (a new one with a stand-in id), and the theme's sample products
   * Apply takes off the shop. Only the preview reads it.
   */
  canvas?: {
    categories: Array<{
      id: string;
      slug: string;
      name: string;
      imageUrl: string | null;
      description: string | null;
      hidden: boolean;
    }>;
    hiddenProductIds: string[];
    /**
     * The store's tagline and footer description as Apply writes them; null
     * is a half the plan leaves as it is. Absent when the plan changes neither.
     */
    brand?: { tagline: string | null; blurb: string | null };
  };
}

// ---------------------------------------------------------------------------
// The chat artifact: the card a start or refine tool adds to its answer.
// ---------------------------------------------------------------------------

export interface RevampArtifact {
  type: "storefront_revamp";
  revampId: string;
  kind: RevampKind;
  /** The status when the answer was written; the card polls for the rest. */
  status: RevampStatus;
}

export function isRevampArtifact(value: unknown): value is RevampArtifact {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "storefront_revamp" &&
    typeof v.revampId === "string" &&
    /^[0-9a-f-]{36}$/i.test(v.revampId) &&
    (REVAMP_KINDS as readonly unknown[]).includes(v.kind) &&
    (REVAMP_STATUSES as readonly unknown[]).includes(v.status)
  );
}
