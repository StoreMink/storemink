import "server-only";

// ---------------------------------------------------------------------------
// Applying a storefront revamp: the plan version 2 half of the personalisation
// action (docs/mink-storefront-revamp.md, section 10).
//
// The revamp's card is a `storefront_personalization` draft whose plan_json
// holds a RevampStoredPlan, so the approval, audit, idempotency, expiry and
// draft lock stay in storefront-personalization-actions.ts and are shared
// with version 1. This module owns what differs: which rows are locked, what
// they are compared with, the guards, the writes, and the snapshot Undo needs.
//
// ★★ EVERY TARGET IS LOCKED AND COMPARED BEFORE THE FIRST WRITE, v1's rule.
//    A revamp touches every page, the header and footer row, the store's own
//    settings, categories and products; checking one, writing it, then finding
//    the next one moved would leave half a storefront redesigned. So the
//    caller locks everything here, compares the whole set with the approved
//    values, runs the guards, and only then calls `writeRevamp`.
//
// ★★ THE SAME APPROVAL VOCABULARY AS VERSION 1. The values below fill the
//    same eight keys (`MinkStorefrontPersonalizationActionValues`), so the
//    shared validator, request hash and approval row need no second shape.
//    Only how each digest is computed differs.
//
// ★ WHAT IS A DRAFT AND WHAT IS LIVE. Page sections and the header and
//   footer land in the private Website Builder draft. Categories, products
//   and the store's tagline are live at once, and the card says so before
//   the button. The snapshot records the state before every one of them, so
//   Undo can put it back.
// ★★ AN EXISTING PAGE'S TITLE AND SEARCH TEXT WAIT FOR PUBLISH. They have no
//    draft layer (the Builder's page settings save them straight to the row),
//    so writing them here would change the live page at Apply while the card
//    says the pages wait for Publish. Apply writes only the sections and
//    records the proposed title and search text in the snapshot; Publish
//    (publish.ts) writes them. A page the revamp creates is a draft page, so
//    it is inserted with its own title and search text.
// ★★ AND WHAT IS LIVE ON AN EXISTING PAGE GOES INTO THE SNAPSHOT TOO
//    (`live`), so Undo and Publish judge its draft by its sections and its
//    live version, never by the page clock a title edit also moves.
// ---------------------------------------------------------------------------

import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  categories,
  mediaAssets,
  minkRevamps,
  products,
  productVariants,
  storeChrome,
  storePages,
  stores,
} from "@/drizzle/schema";
import { sanitizeChromeForSave, type StoreChrome } from "@/lib/chrome/types";
import type { Db } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";
import { getProductCreateCapacity } from "@/lib/plans/entitlements";
import { resolveOptionRows } from "@/lib/products/options";
import {
  validatePageSlug,
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { MinkRequestError } from "../errors";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import { assertLayoutPreservesCustomCode } from "../storefront-layout-contract";
import {
  assertLayoutMediaIsOwned,
  collectSectionMediaUrls,
} from "../storefront-media-policy";
import { selectOwnedStorefrontImageUrls } from "../storefront-media-read";
import type { MinkStorefrontPersonalizationActionValues } from "../storefront-personalization-action-types";
import {
  isThemePhotoUrl,
  type PersonalizationStoredCategory,
} from "../storefront-personalization-contract";
import { readMenusAsChrome } from "../storefront-personalization-context";
import type { MinkActorContext } from "../types";
import {
  countLabel,
  isRevampPlan,
  REVAMP_LIMITS,
  type RevampStoredPage,
  type RevampStoredPlan,
  type RevampStoredProductCreate,
} from "./contract";
import {
  revampBrandDigest,
  revampChromeDigest,
  revampSectionsDigest,
} from "./digests";
import {
  REVAMP_HIDDEN_MEDIA_SOURCE,
  REVAMP_IMAGE_FOLDER,
  REVAMP_REVEALED_MEDIA_SOURCE,
} from "./image-store";
import {
  REVAMP_LIFECYCLE_VERSION,
  type RevampApplySnapshot,
  type RevampApplySnapshotCategory,
  type RevampApplySnapshotPage,
} from "./lifecycle-types";
import {
  revampRefinementStale,
  type RevampCategoryChangeLike,
} from "./request";

type Values = MinkStorefrontPersonalizationActionValues;

/** v1's "nothing of this kind in the plan" digest value. */
const NONE = "none";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_SLUG_MAX = 120;
/** numeric(10,2): the most a price column holds. */
const MAX_PRICE = 99_999_999;
/** resolveOptionRows' own combination ceiling. */
const MAX_VARIANTS = 100;

export const REVAMP_CONFLICT_MESSAGE =
  "Part of your store changed after this redesign was made. Ask Mink to make it again.";

/** The one answer to "something moved": nothing was written. */
export function revampTargetConflict(): MinkRequestError {
  return new MinkRequestError(
    "mink_personalization_target_conflict",
    REVAMP_CONFLICT_MESSAGE,
    409,
  );
}

/** The plan's product cap, in the plan's own words. */
export function revampProductCapConflict(message: string): MinkRequestError {
  return new MinkRequestError("mink_revamp_product_cap", message, 409);
}

export const REVAMP_ALREADY_APPLIED_MESSAGE =
  "This redesign is already in your Website Builder draft.";
export const REVAMP_UNDONE_MESSAGE =
  "This redesign was undone. Ask Mink to make it again.";
export const REVAMP_REFINEMENT_BUILDING_MESSAGE =
  "A newer version of this redesign is being made. Apply it when its card is ready, or stop it on its card first.";
export const REVAMP_PARENT_APPLIED_MESSAGE =
  "An earlier version of this redesign was applied after you asked for these changes. Ask Mink to make them again.";
export const REVAMP_PARENT_UNDONE_MESSAGE =
  "An earlier version of this redesign was undone after you asked for these changes. Ask Mink to make them again.";

// ---------------------------------------------------------------------------
// The revamp's job.
// ---------------------------------------------------------------------------

/** What Apply found of the revamp's job under its lock. */
export interface RevampJobLock {
  /** False when the job is gone: that never blocks Apply, it only costs Undo. */
  found: boolean;
}

/**
 * Lock the revamp's job and refuse a redesign Apply already wrote.
 * ★★ ONE APPLY PER JOB. A second would write the store again while the job's
 *    snapshot records only one of the writes, and an Apply after Undo would
 *    leave changes that no Publish or Undo can reach (both treat an undone
 *    job as finished). The page and chrome digests usually catch both; this
 *    states the rule rather than leaving it to them.
 * ★ LOCKED BEFORE ANY STORE ROW, the order Publish and Undo take (the job,
 *   then the pages), so the three can never wait on each other in a circle;
 *   and two Applies of the same card are already serialised by the draft lock.
 * ★ The card's draft id IS the revamp's id, so either matches (the record
 *   below matches the same way).
 * ★★ A REDESIGN WITH MORE THAN ONE VERSION (chat-1). A refinement decides
 *    what it carries of its earlier versions when it is asked for, yet those
 *    can still be applied or undone while it is being made. So a card whose
 *    refinement is being made is not applied (that refinement carries this
 *    card's products and categories, and its own Apply would then refuse),
 *    and a refinement whose earlier versions changed since is refused
 *    (`refuseStaleRefinement`).
 */
export async function lockRevampJob(
  db: Db,
  actor: MinkActorContext,
  input: { revampId: string; draftId: string },
): Promise<RevampJobLock> {
  const rows = await db.execute(sql`
    select id, parent_id, applied_at, undone_at, request from public.mink_revamps
    where store_id = ${actor.storeId}::uuid
      and (id = ${input.revampId}::uuid or draft_id = ${input.draftId}::uuid)
    order by id
    for update
  `);
  const jobs = rows.rows as RevampVersionRow[];
  if (jobs.some((job) => job.undone_at)) {
    throw new MinkRequestError(
      "mink_revamp_undone",
      REVAMP_UNDONE_MESSAGE,
      409,
    );
  }
  if (jobs.some((job) => job.applied_at)) {
    throw new MinkRequestError(
      "mink_revamp_already_applied",
      REVAMP_ALREADY_APPLIED_MESSAGE,
      409,
    );
  }
  const job = jobs.find((row) => row.id === input.revampId) ?? jobs[0];
  if (job) {
    await refuseWhileRefined(db, actor, job.id);
    await refuseStaleRefinement(db, actor, job);
  }
  return { found: jobs.length > 0 };
}

/** One version of a redesign as Apply locks it. */
type RevampVersionRow = {
  id: string;
  parent_id?: string | null;
  applied_at: string | null;
  undone_at: string | null;
  request?: unknown;
};

/**
 * A card with a refinement still being made is not applied. ★ A plain read:
 * the refinement's runner never touches this card, so nothing here waits on
 * it; one created a moment later is caught by its own Apply instead.
 */
async function refuseWhileRefined(
  db: Db,
  actor: MinkActorContext,
  revampId: string,
): Promise<void> {
  const rows = await db.execute(sql`
    select id from public.mink_revamps
    where store_id = ${actor.storeId}::uuid
      and parent_id = ${revampId}::uuid
      and status in ('queued', 'running')
    limit 1
  `);
  if (rows.rows.length) {
    throw new MinkRequestError(
      "mink_revamp_refinement_building",
      REVAMP_REFINEMENT_BUILDING_MESSAGE,
      409,
    );
  }
}

/**
 * Refuse a refinement whose earlier versions were applied or undone after it
 * was asked for (`revampRefinementStale`): applied, it would create their
 * products and categories a second time; undone, it would leave them gone
 * while its pages and menus point at them.
 * ★★ EVERY EARLIER VERSION IS LOCKED, nearest first, after the job: an Undo or
 *    Apply of one of them takes that version's job lock too, so it waits for
 *    this Apply instead of changing the store between the check and the
 *    write. Nearest first is the order every Apply locks a chain in (its own
 *    job, then upwards), so two of them never wait on each other in a circle.
 */
async function refuseStaleRefinement(
  db: Db,
  actor: MinkActorContext,
  job: RevampVersionRow,
): Promise<void> {
  const chain: RevampVersionRow[] = [];
  let next = job.parent_id ?? null;
  while (next && chain.length <= REVAMP_LIMITS.maxRefinements) {
    const rows = await db.execute(sql`
      select id, parent_id, applied_at, undone_at, request from public.mink_revamps
      where store_id = ${actor.storeId}::uuid and id = ${next}::uuid
      for update
    `);
    const row = rows.rows[0] as RevampVersionRow | undefined;
    if (!row || row.id === job.id || chain.some((v) => v.id === row.id)) break;
    chain.push(row);
    next = row.parent_id ?? null;
  }
  if (!chain.length) return;
  const stale = revampRefinementStale(
    storedVersionItems(job.request),
    chain.map((row) => ({
      ...storedVersionItems(row.request),
      live: Boolean(row.applied_at) && !row.undone_at,
    })),
  );
  if (stale === "applied") {
    throw new MinkRequestError(
      "mink_revamp_parent_applied",
      REVAMP_PARENT_APPLIED_MESSAGE,
      409,
    );
  }
  if (stale === "undone") {
    throw new MinkRequestError(
      "mink_revamp_parent_undone",
      REVAMP_PARENT_UNDONE_MESSAGE,
      409,
    );
  }
}

/**
 * The products (key and name) and category changes a stored request asked
 * for. ★ Read defensively: a row the job's own reader would refuse has asked
 * for nothing this can compare, which never refuses an Apply on its own.
 */
function storedVersionItems(request: unknown): {
  products: Array<{ key: string; name: string }>;
  categories: RevampCategoryChangeLike[];
} {
  const row = asRecord(request);
  const products = (Array.isArray(row.products) ? row.products : []).flatMap(
    (entry: unknown) =>
      isRecord(entry) &&
      typeof entry.key === "string" &&
      typeof entry.name === "string"
        ? [{ key: entry.key, name: entry.name }]
        : [],
  );
  const categories = (
    Array.isArray(row.categories) ? row.categories : []
  ).flatMap((entry: unknown): RevampCategoryChangeLike[] =>
    isRecord(entry) && typeof entry.action === "string"
      ? [
          {
            action: entry.action,
            slug: typeof entry.slug === "string" ? entry.slug : null,
            name: typeof entry.name === "string" ? entry.name : null,
            description:
              typeof entry.description === "string" ? entry.description : null,
            newPhoto: entry.newPhoto === true,
          },
        ]
      : [],
  );
  return { products, categories };
}

// ---------------------------------------------------------------------------
// Reading the stored plan.
// ---------------------------------------------------------------------------

/**
 * The stored revamp plan, re-validated. ★ Every page's sections pass the
 * draft-mode registry check and must still hash to the digest the approval
 * is bound to, and every new product's sizes must resolve into variants the
 * product editor would accept, so a row edited by hand is refused at the
 * preview rather than half-written at Apply.
 */
export function readRevampStoredPlan(
  raw: string | undefined,
): RevampStoredPlan {
  const plan = JSON.parse(raw ?? "") as RevampStoredPlan;
  if (
    !isRevampPlan(plan) ||
    typeof plan.revampId !== "string" ||
    !UUID.test(plan.revampId) ||
    !Array.isArray(plan.pages) ||
    !Array.isArray(plan.categories) ||
    !isRecord(plan.products) ||
    !Array.isArray(plan.products.hide) ||
    !Array.isArray(plan.products.create) ||
    !Array.isArray(plan.photos) ||
    plan.pages.length > REVAMP_LIMITS.maxPages ||
    plan.categories.length > REVAMP_LIMITS.maxCategoryChanges ||
    plan.products.create.length > REVAMP_LIMITS.maxProducts
  ) {
    throw new Error("The saved redesign is not readable.");
  }
  if (
    plan.chrome !== null &&
    (!isRecord(plan.chrome) ||
      typeof plan.chrome.expectedDigest !== "string" ||
      !isRecord(plan.chrome.next))
  ) {
    throw new Error("The saved header and footer are not readable.");
  }
  if (
    plan.brand !== null &&
    (!isRecord(plan.brand) || typeof plan.brand.expectedDigest !== "string")
  ) {
    throw new Error("The saved store description is not readable.");
  }
  const pageSlugs = new Set<string>();
  for (const page of plan.pages) readPage(page, pageSlugs);
  for (const change of plan.categories) {
    if (
      !isRecord(change) ||
      !["update", "create", "hide"].includes(String(change.action)) ||
      typeof change.slug !== "string" ||
      (change.action !== "create" &&
        (!UUID.test(String(change.id)) ||
          typeof change.expectedUpdatedAt !== "string"))
    ) {
      throw new Error("A saved category change is not readable.");
    }
  }
  for (const product of plan.products.hide) {
    if (
      !isRecord(product) ||
      !UUID.test(String(product.id)) ||
      typeof product.expectedUpdatedAt !== "string"
    ) {
      throw new Error("A saved sample product is not readable.");
    }
  }
  const productSlugs = new Set<string>();
  for (const product of plan.products.create)
    readProduct(product, productSlugs);
  return plan;
}

function readPage(page: RevampStoredPage, seen: Set<string>) {
  const label =
    isRecord(page) && typeof page.title === "string" && page.title.trim()
      ? page.title.trim()
      : "a page";
  if (
    !isRecord(page) ||
    typeof page.slug !== "string" ||
    typeof page.title !== "string" ||
    typeof page.seoTitle !== "string" ||
    typeof page.seoDescription !== "string" ||
    typeof page.proposedDigest !== "string"
  ) {
    throw new Error(`The saved page "${label}" is not readable.`);
  }
  if (page.create) {
    const slug = validatePageSlug(page.slug);
    if (
      page.pageId !== null ||
      !page.title.trim() ||
      "error" in slug ||
      slug.slug !== page.slug
    ) {
      throw new Error(
        `The saved page "${label}" has an address the store cannot use.`,
      );
    }
  } else if (
    typeof page.pageId !== "string" ||
    !UUID.test(page.pageId) ||
    typeof page.expectedVersion !== "string" ||
    typeof page.expectedDigest !== "string"
  ) {
    throw new Error(`The saved page "${label}" is not readable.`);
  }
  if (seen.has(page.slug)) {
    throw new Error(`The saved redesign names the page "${label}" twice.`);
  }
  seen.add(page.slug);
  const validated = validateSections(page.sections, { mode: "draft" });
  if ("error" in validated) {
    throw new Error(
      `The saved page "${label}" is not valid: ${validated.error}`,
    );
  }
  if (revampSectionsDigest(page.sections) !== page.proposedDigest) {
    throw new Error("A saved page does not match its digest.");
  }
}

function readProduct(product: RevampStoredProductCreate, seen: Set<string>) {
  const label =
    isRecord(product) && typeof product.name === "string" && product.name.trim()
      ? product.name.trim()
      : "a product";
  if (
    !isRecord(product) ||
    typeof product.key !== "string" ||
    typeof product.name !== "string" ||
    !product.name.trim() ||
    typeof product.slug !== "string" ||
    product.slug.length > PRODUCT_SLUG_MAX ||
    !PRODUCT_SLUG.test(product.slug) ||
    typeof product.description !== "string" ||
    !(
      product.categorySlug === null || typeof product.categorySlug === "string"
    ) ||
    !nullableText(product.imageUrl) ||
    !nullableText(product.sourceImageUrl) ||
    !Array.isArray(product.variants) ||
    product.variants.length > MAX_VARIANTS ||
    !validPrice(product.price, product.mrp)
  ) {
    throw new Error(`The saved product "${label}" is not readable.`);
  }
  for (const variant of product.variants) {
    if (
      !isRecord(variant) ||
      typeof variant.name !== "string" ||
      !Array.isArray(variant.optionValues) ||
      variant.optionValues.some((value) => typeof value !== "string") ||
      !validPrice(variant.price, variant.mrp)
    ) {
      throw new Error(`A size of "${label}" is not readable.`);
    }
  }
  if (seen.has(product.slug)) {
    throw new Error(`The saved redesign adds "${label}" twice.`);
  }
  seen.add(product.slug);
  const resolved = resolveOptionRows(product.options, variantRows(product));
  if ("error" in resolved) {
    throw new Error(
      `The sizes of "${label}" are not usable: ${resolved.error}`,
    );
  }
}

function variantRows(product: RevampStoredProductCreate) {
  return product.variants.map((variant) => ({
    name: variant.name,
    option_values: variant.optionValues,
    price: variant.price,
    mrp: variant.mrp ?? null,
  }));
}

/** A selling price, and an MRP that is absent or a real amount. */
function validPrice(price: unknown, mrp: unknown): boolean {
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price <= 0 ||
    price > MAX_PRICE
  ) {
    return false;
  }
  return (
    mrp === null ||
    mrp === undefined ||
    (typeof mrp === "number" &&
      Number.isFinite(mrp) &&
      mrp > 0 &&
      mrp <= MAX_PRICE)
  );
}

/**
 * The struck-through MRP the row stores. ★ An MRP at or below the selling
 * price is not a saving, so the price itself is stored (nothing is struck
 * through); the selling price is never lowered to meet it, which is what the
 * product editor's own normalising would do to a price the merchant named.
 */
function listPrice(price: number, mrp: number | null | undefined): number {
  return typeof mrp === "number" && mrp > price ? mrp : price;
}

// ---------------------------------------------------------------------------
// Authority.
// ---------------------------------------------------------------------------

/**
 * The parts outside the Builder keep their own permission (v1's rule).
 * ★ The tagline and footer description are written to the live store at
 *   Apply, and everywhere else only saveStoreBranding saves them, behind
 *   Branding manage; Builder manage alone covers the colour and logo
 *   (saveBrandAppearance), not these two.
 */
export function assertRevampPartAuthority(
  actor: MinkActorContext,
  plan: RevampStoredPlan,
) {
  if (
    plan.categories.length &&
    !can(actor.permissions, "categories", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_personalization_access_denied",
      "This redesign changes categories, which needs Categories manage permission.",
      403,
    );
  }
  if (
    (plan.products.hide.length || plan.products.create.length) &&
    !can(actor.permissions, "products", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_personalization_access_denied",
      "This redesign adds or unpublishes products, which needs Products manage permission.",
      403,
    );
  }
  if (
    plan.brand &&
    !can(actor.permissions, "branding", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_personalization_access_denied",
      "This redesign changes your store's tagline or footer description, which needs Branding manage permission.",
      403,
    );
  }
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

interface LockedPage {
  slug: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  updatedAt: string;
  /** Null when the stored draft no longer validates: always a conflict. */
  sections: PageSectionItem[] | null;
  /** The stored draft exactly as it is, for the snapshot Undo restores. */
  stored: PageSectionItem[];
  /**
   * What shoppers see, read under the same lock: the page's status and its
   * `published_sections` exactly as stored. Apply never publishes, so this is
   * also what is live once Apply has written (the snapshot's `live`).
   */
  status: string;
  publishedSections: unknown;
}

/**
 * ★ CONTENT, NOT ONLY THE CLOCK (v1's category rule): a category is checked
 * on what a shopper sees as well as `updated_at`.
 */
interface LockedCategory {
  updatedAt: string;
  status: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
}

export interface RevampLockedTargets {
  pages: Map<string, LockedPage>;
  /** Addresses of pages the plan creates that are already in use. */
  takenPageSlugs: Set<string>;
  chrome: { exists: boolean; value: StoreChrome } | null;
  /** Null when the store row could not be read: always a conflict. */
  storeSettings: Record<string, unknown> | null;
  categories: Map<string, LockedCategory>;
  takenCategorySlugs: Set<string>;
  /** Existing categories a new product names, by slug. */
  categoryIdsBySlug: Map<string, string>;
  hiddenProducts: Map<
    string,
    {
      updatedAt: string;
      status: string;
      name: string;
      publishedAt: string | null;
    }
  >;
  takenProductSlugs: Set<string>;
  /** The plan's product cap, read under its own lock; null with no new products. */
  productCapacity: { allowed: number; error: string } | null;
}

/**
 * Lock every row the revamp writes, in v1's order (pages, chrome, store,
 * categories, products), and read what each is compared with. ★ The preview
 * takes the same locks the write will, so the two read one way.
 */
export async function lockRevampTargets(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
): Promise<RevampLockedTargets> {
  const storeId = actor.storeId;

  const pageIds = plan.pages.flatMap((page) =>
    !page.create && page.pageId ? [page.pageId] : [],
  );
  const pages = new Map<string, LockedPage>();
  if (pageIds.length) {
    const rows = await db.execute(sql`
      select id, slug, title, seo_title, seo_description, updated_at, sections,
             status, published_sections
      from public.store_pages
      where store_id = ${storeId}::uuid
        and id = any(${sql.param(pageIds)}::uuid[])
      order by id
      for update
    `);
    for (const row of rows.rows as Array<{
      id: string;
      slug: string;
      title: string | null;
      seo_title: string | null;
      seo_description: string | null;
      updated_at: string;
      sections: unknown;
      status: string;
      published_sections: unknown;
    }>) {
      const validated = validateSections(row.sections, { mode: "draft" });
      pages.set(row.id, {
        slug: row.slug,
        title: row.title ?? "",
        seoTitle: row.seo_title ?? "",
        seoDescription: row.seo_description ?? "",
        updatedAt: String(row.updated_at),
        sections: "error" in validated ? null : validated.sections,
        stored: Array.isArray(row.sections)
          ? (row.sections as PageSectionItem[])
          : [],
        status: row.status,
        publishedSections: row.published_sections,
      });
    }
  }
  const newPageSlugs = plan.pages.flatMap((page) =>
    page.create ? [page.slug] : [],
  );
  const takenPageSlugs = new Set<string>();
  if (newPageSlugs.length) {
    const rows = await db.execute(sql`
      select slug from public.store_pages
      where store_id = ${storeId}::uuid
        and slug = any(${sql.param(newPageSlugs)}::text[])
    `);
    for (const row of rows.rows as Array<{ slug: string }>) {
      takenPageSlugs.add(row.slug);
    }
  }

  let chrome: RevampLockedTargets["chrome"] = null;
  if (plan.chrome) {
    const rows = await db.execute(sql`
      select draft from public.store_chrome
      where store_id = ${storeId}::uuid
      for update
    `);
    const row = rows.rows[0] as { draft: unknown } | undefined;
    // ★ With no row yet, the store's own menus are its header and footer
    //   (v1's rule, and what the snapshot digested): DEFAULT_CHROME here
    //   would report a conflict on every store that never opened the Brand
    //   panel.
    chrome = {
      exists: Boolean(row),
      value: row
        ? sanitizeChromeForSave(row.draft)
        : await readMenusAsChrome(db, storeId, { forUpdate: true }),
    };
  }

  let storeSettings: Record<string, unknown> | null = null;
  if (plan.brand) {
    const rows = await db.execute(sql`
      select settings from public.stores
      where id = ${storeId}::uuid
      for update
    `);
    const row = rows.rows[0] as { settings?: unknown } | undefined;
    storeSettings = row ? asRecord(row.settings) : null;
  }

  const categoryIds = plan.categories.flatMap((change) =>
    change.action === "create" ? [] : [change.id],
  );
  const categoryRows = new Map<string, LockedCategory>();
  if (categoryIds.length) {
    const rows = await db.execute(sql`
      select id, updated_at, status, name, description, image_url
      from public.categories
      where store_id = ${storeId}::uuid
        and id = any(${sql.param(categoryIds)}::uuid[])
      order by id
      for update
    `);
    for (const row of rows.rows as Array<{
      id: string;
      updated_at: string;
      status: string;
      name: string;
      description: string | null;
      image_url: string | null;
    }>) {
      categoryRows.set(row.id, {
        updatedAt: String(row.updated_at),
        status: row.status,
        name: row.name,
        description: row.description ?? null,
        imageUrl: row.image_url ?? null,
      });
    }
  }
  const newCategorySlugs = plan.categories.flatMap((change) =>
    change.action === "create" ? [change.slug] : [],
  );
  for (const slug of newCategorySlugs) {
    // ★ The category path's own lock, so a category editor or another Mink
    //   approval creating the same address cannot race past this check.
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`mink-category-slug:${storeId}:${slug}`}, 0)
      )
    `);
  }
  const productCategorySlugs = plan.products.create.flatMap((product) =>
    product.categorySlug && !newCategorySlugs.includes(product.categorySlug)
      ? [product.categorySlug]
      : [],
  );
  const lookupSlugs = [
    ...new Set([...newCategorySlugs, ...productCategorySlugs]),
  ];
  const takenCategorySlugs = new Set<string>();
  const categoryIdsBySlug = new Map<string, string>();
  if (lookupSlugs.length) {
    const rows = await db
      .select({ id: categories.id, slug: categories.slug })
      .from(categories)
      .where(
        and(
          eq(categories.storeId, storeId),
          inArray(categories.slug, lookupSlugs),
        ),
      );
    for (const row of rows) {
      categoryIdsBySlug.set(row.slug, row.id);
      if (newCategorySlugs.includes(row.slug)) takenCategorySlugs.add(row.slug);
    }
  }

  const hideIds = plan.products.hide.map((product) => product.id);
  const hiddenProducts: RevampLockedTargets["hiddenProducts"] = new Map();
  if (hideIds.length) {
    const rows = await db.execute(sql`
      select id, updated_at, status, name, published_at from public.products
      where store_id = ${storeId}::uuid
        and id = any(${sql.param(hideIds)}::uuid[])
      order by id
      for update
    `);
    for (const row of rows.rows as Array<{
      id: string;
      updated_at: string;
      status: string;
      name: string;
      published_at?: string | null;
    }>) {
      hiddenProducts.set(row.id, {
        updatedAt: String(row.updated_at),
        status: row.status,
        name: row.name,
        // ★ Kept for Undo: hiding clears it, and a sample put back on the
        //   shop should carry the date it was first published, not none.
        publishedAt: row.published_at ? String(row.published_at) : null,
      });
    }
  }
  const newProductSlugs = plan.products.create.map((product) => product.slug);
  const takenProductSlugs = new Set<string>();
  let productCapacity: RevampLockedTargets["productCapacity"] = null;
  if (newProductSlugs.length) {
    const rows = await db
      .select({ slug: products.slug })
      .from(products)
      .where(
        and(
          eq(products.storeId, storeId),
          inArray(products.slug, newProductSlugs),
        ),
      );
    for (const row of rows) takenProductSlugs.add(row.slug);
    // ★ The editor's own cap, under its own advisory lock held to commit, so
    //   a product created elsewhere meanwhile cannot take the same slots.
    productCapacity = await getProductCreateCapacity(
      db,
      storeId,
      newProductSlugs.length,
    );
  }

  return {
    pages,
    takenPageSlugs,
    chrome,
    storeSettings,
    categories: categoryRows,
    takenCategorySlugs,
    categoryIdsBySlug,
    hiddenProducts,
    takenProductSlugs,
    productCapacity,
  };
}

// ---------------------------------------------------------------------------
// The approval's values.
// ---------------------------------------------------------------------------

/** What the plan expects to find, from the versions it recorded. */
export function revampExpectedValues(
  planDigest: string,
  plan: RevampStoredPlan,
): Values {
  return {
    plan_digest: planDigest,
    pages_digest: digestMinkStorefrontValue(
      plan.pages.map((page) =>
        page.create
          ? { slug: page.slug, create: true, taken: false }
          : {
              id: page.pageId,
              version: normalizeTimestamp(page.expectedVersion ?? ""),
              digest: page.expectedDigest,
            },
      ),
    ),
    chrome_digest: plan.chrome
      ? digestMinkStorefrontValue({ digest: plan.chrome.expectedDigest })
      : NONE,
    brand_digest: plan.brand ? plan.brand.expectedDigest : NONE,
    categories_digest: plan.categories.length
      ? digestMinkStorefrontValue({
          rows: plan.categories.flatMap((change) => {
            if (change.action === "create") return [];
            const version = normalizeTimestamp(change.expectedUpdatedAt);
            return [
              change.action === "update"
                ? categoryCheckpoint(change, { version, ...change.before })
                : categoryCheckpoint(change, {
                    version,
                    name: change.name,
                    description: null,
                    imageUrl: null,
                  }),
            ];
          }),
          taken: [],
        })
      : NONE,
    products_digest: hasProductChanges(plan)
      ? digestMinkStorefrontValue({
          hide: plan.products.hide.map((product) => ({
            id: product.id,
            version: normalizeTimestamp(product.expectedUpdatedAt),
            status: "published",
            name: product.name,
          })),
          create: plan.products.create.map((product) => ({
            slug: product.slug,
            taken: false,
          })),
        })
      : NONE,
    page_count: String(plan.pages.length),
    photo_count: String(plan.photos.length),
  };
}

/** The store as it is now, in the same vocabulary. */
export function revampCurrentValues(
  planDigest: string,
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
): Values {
  return {
    plan_digest: planDigest,
    pages_digest: digestMinkStorefrontValue(
      plan.pages.map((page) => {
        if (page.create) {
          return {
            slug: page.slug,
            create: true,
            taken: locked.takenPageSlugs.has(page.slug),
          };
        }
        const current = page.pageId ? locked.pages.get(page.pageId) : undefined;
        return {
          id: page.pageId,
          version: current ? normalizeTimestamp(current.updatedAt) : null,
          digest: current?.sections
            ? revampSectionsDigest(current.sections)
            : null,
        };
      }),
    ),
    chrome_digest: plan.chrome
      ? digestMinkStorefrontValue({
          digest: locked.chrome
            ? revampChromeDigest(locked.chrome.value)
            : null,
        })
      : NONE,
    brand_digest: plan.brand
      ? locked.storeSettings
        ? revampBrandDigest(locked.storeSettings)
        : digestMinkStorefrontValue({ store: "unreadable" })
      : NONE,
    categories_digest: plan.categories.length
      ? digestMinkStorefrontValue({
          rows: plan.categories.flatMap((change) => {
            if (change.action === "create") return [];
            const current = locked.categories.get(change.id);
            return [
              categoryCheckpoint(change, {
                version: current ? normalizeTimestamp(current.updatedAt) : null,
                name: current?.name ?? null,
                description: current?.description ?? null,
                imageUrl: current?.imageUrl ?? null,
              }),
            ];
          }),
          taken: [...locked.takenCategorySlugs].sort(),
        })
      : NONE,
    products_digest: hasProductChanges(plan)
      ? digestMinkStorefrontValue({
          hide: plan.products.hide.map((product) => {
            const current = locked.hiddenProducts.get(product.id);
            return {
              id: product.id,
              version: current ? normalizeTimestamp(current.updatedAt) : null,
              status: current?.status ?? null,
              name: current?.name ?? null,
            };
          }),
          // ★ A new product's category is not part of the lock. The merchant
          //   names it in the chat and nothing checks it against the store
          //   (request.ts), so it may name a category that never existed, or
          //   one deleted since: either way the product still goes on the
          //   shop, filed without a category and named in the snapshot's
          //   notes (createProducts), rather than failing the whole Apply.
          create: plan.products.create.map((product) => ({
            slug: product.slug,
            taken: locked.takenProductSlugs.has(product.slug),
          })),
        })
      : NONE,
    page_count: String(plan.pages.length),
    photo_count: String(plan.photos.length),
  };
}

/** What the store will hold once the plan is written. */
export function revampProposedValues(
  planDigest: string,
  plan: RevampStoredPlan,
): Values {
  return {
    plan_digest: planDigest,
    pages_digest: digestMinkStorefrontValue(
      plan.pages.map((page) => ({
        id: page.pageId,
        slug: page.slug,
        title: page.title,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
        digest: page.proposedDigest,
      })),
    ),
    chrome_digest: plan.chrome
      ? revampChromeDigest(sanitizeChromeForSave(plan.chrome.next))
      : NONE,
    brand_digest: plan.brand ? digestMinkStorefrontValue(plan.brand) : NONE,
    categories_digest: plan.categories.length
      ? digestMinkStorefrontValue(plan.categories)
      : NONE,
    products_digest: hasProductChanges(plan)
      ? digestMinkStorefrontValue({
          hide: plan.products.hide.map((product) => product.id),
          create: plan.products.create,
        })
      : NONE,
    page_count: String(plan.pages.length),
    photo_count: String(plan.photos.length),
  };
}

/** For the audit row: which parts moved between the preview and now. */
export function revampConflictDetail(approved: Values, now: Values): string {
  const parts = (
    [
      ["pages_digest", "pages"],
      ["chrome_digest", "header and footer"],
      ["brand_digest", "store description"],
      ["categories_digest", "categories"],
      ["products_digest", "products"],
    ] as const
  ).flatMap(([key, label]) => (approved[key] === now[key] ? [] : [label]));
  return `Part of the store changed after the approval preview (${parts.join(", ") || "the plan"}).`;
}

/** The product cap's sentence when the new products do not fit, else null. */
export function revampCapIssue(
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
): string | null {
  const wanted = plan.products.create.length;
  if (!wanted || !locked.productCapacity) return null;
  return locked.productCapacity.allowed < wanted
    ? locked.productCapacity.error
    : null;
}

/**
 * What the digests cannot see, re-checked under the same locks: custom code
 * kept byte for byte, and every new picture still one the store owns (a
 * theme's own picture counts, being what the theme installs). Returns the
 * audit sentence for the first problem, or null.
 */
export async function rerunRevampGuards(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
): Promise<string | null> {
  const media: Array<{
    page: RevampStoredPage;
    onPage: string[];
    fresh: string[];
  }> = [];
  for (const page of plan.pages) {
    const current = page.create
      ? []
      : page.pageId
        ? locked.pages.get(page.pageId)?.sections
        : null;
    if (!current) return "A Website Builder page is no longer valid.";
    if (assertLayoutPreservesCustomCode(page.sections, current).length) {
      return "The redesigned pages no longer keep the custom code on them.";
    }
    const onPage = collectSectionMediaUrls(current);
    const known = new Set(onPage);
    media.push({
      page,
      onPage,
      fresh: collectSectionMediaUrls(page.sections).filter(
        (url) => !known.has(url) && !isThemePhotoUrl(url),
      ),
    });
  }
  const categoryImages = plan.categories.flatMap((change) =>
    change.action !== "hide" && change.imageUrl ? [change.imageUrl] : [],
  );
  const productImages = plan.products.create.flatMap((product) =>
    [product.imageUrl, product.sourceImageUrl].filter(
      (url): url is string => !!url,
    ),
  );
  const candidates = [
    ...new Set([
      ...media.flatMap((entry) => entry.fresh),
      ...categoryImages,
      ...productImages,
    ]),
  ];
  // ★ One ownership query for every new picture, not one per page.
  const owned = candidates.length
    ? await selectOwnedStorefrontImageUrls(db, actor.storeId, candidates)
    : new Set<string>();
  for (const { page, onPage, fresh } of media) {
    const allowed = [
      ...onPage,
      ...collectSectionMediaUrls(page.sections).filter(isThemePhotoUrl),
      ...fresh.filter((url) => owned.has(url)),
    ];
    if (assertLayoutMediaIsOwned(page.sections, allowed).length) {
      return "A new photo is no longer in this store's Media Library.";
    }
  }
  if (categoryImages.some((url) => !owned.has(url))) {
    return "A category photo is no longer in this store's Media Library.";
  }
  if (productImages.some((url) => !owned.has(url))) {
    return "A product photo is no longer in this store's Media Library.";
  }
  for (const page of plan.pages) {
    if (page.create && locked.takenPageSlugs.has(page.slug)) {
      return "A page with one of the new addresses was created in the meantime.";
    }
  }
  for (const change of plan.categories) {
    if (
      change.action === "create" &&
      locked.takenCategorySlugs.has(change.slug)
    ) {
      return "A category with one of the new addresses was created in the meantime.";
    }
  }
  for (const product of plan.products.hide) {
    const current = locked.hiddenProducts.get(product.id);
    if (!current || current.status !== "published") {
      return "A sample product changed after the approval preview.";
    }
  }
  for (const product of plan.products.create) {
    if (locked.takenProductSlugs.has(product.slug)) {
      return "A product with one of the new addresses was created in the meantime.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writes. Every precondition was checked under lock before the first one.
// ---------------------------------------------------------------------------

/**
 * Write the whole plan and return the snapshot of everything it replaced or
 * created. ★ Throws (rolling the transaction back) if a locked row is
 * somehow missing, so a half-written revamp can never commit.
 */
export async function writeRevamp(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
  writtenAt: string,
): Promise<RevampApplySnapshot> {
  const pages = await writePages(db, actor, plan, locked);
  const chrome = await writeChrome(db, actor, plan, locked, writtenAt);
  const brand = await writeBrand(db, actor, plan, locked.storeSettings);
  const written = await writeCategories(db, actor, plan, locked, writtenAt);
  const hidden = await hideSampleProducts(db, actor, plan, locked);
  const notes: string[] = [];
  const created = await createProducts(
    db,
    actor,
    plan,
    written.idsBySlug,
    writtenAt,
    notes,
  );
  await revealRevampPhotos(db, actor, plan);
  return {
    version: REVAMP_LIFECYCLE_VERSION,
    appliedAt: writtenAt,
    pages,
    chrome,
    brand,
    categories: written.snapshot,
    products: { hidden, created },
    ...(notes.length ? { notes } : {}),
  };
}

async function writePages(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
): Promise<RevampApplySnapshotPage[]> {
  const out: RevampApplySnapshotPage[] = [];
  for (const page of plan.pages) {
    if (page.create) {
      // ★ A new page is a DRAFT with nothing live: shoppers see it only once
      //   it is published, like any page the merchant adds in the Builder.
      const [row] = await db
        .insert(storePages)
        .values({
          storeId: actor.storeId,
          slug: page.slug,
          title: page.title,
          status: "draft",
          seoTitle: page.seoTitle,
          seoDescription: page.seoDescription,
          sections: page.sections,
          publishedSections: [],
          createdBy: actor.adminId,
          updatedBy: actor.adminId,
        })
        .returning({ id: storePages.id, updatedAt: storePages.updatedAt });
      if (!row) throw revampTargetConflict();
      out.push({
        pageId: row.id,
        slug: page.slug,
        created: true,
        before: null,
        afterUpdatedAt: row.updatedAt,
        afterDigest: page.proposedDigest,
        proposed: null,
      });
      continue;
    }
    const pageId = page.pageId;
    const current = pageId ? locked.pages.get(pageId) : undefined;
    if (!pageId || !current) throw revampTargetConflict();
    // ★★ The sections only: the title and search text are live the moment
    //    they are written, so they wait in the snapshot for Publish.
    const [row] = await db
      .update(storePages)
      .set({ sections: page.sections, updatedBy: actor.adminId })
      .where(
        and(eq(storePages.id, pageId), eq(storePages.storeId, actor.storeId)),
      )
      .returning({ id: storePages.id, updatedAt: storePages.updatedAt });
    // Rows are locked; a missing one means the transaction must not commit.
    if (!row) throw revampTargetConflict();
    out.push({
      pageId,
      slug: page.slug,
      created: false,
      before: {
        title: current.title,
        seoTitle: current.seoTitle,
        seoDescription: current.seoDescription,
        sections: current.stored,
      },
      afterUpdatedAt: row.updatedAt,
      afterDigest: page.proposedDigest,
      proposed: {
        title: page.title,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
      },
      // ★★ WHAT IS LIVE, so an Undo before any Publish need not read the
      //    page clock, which the merchant's own title or search text edit
      //    moves too: by the clock, a draft still the redesign's reads as
      //    theirs and stays. Apply never publishes, so what it read under
      //    the lock is what is live now. The digest is over
      //    `published_sections` exactly as stored, a value that is not a
      //    list counting as an empty one, because that is how publish.ts
      //    digests the row it compares this with (a validated copy can
      //    differ from it). The status column's CHECK (draft or published)
      //    keeps the status one publish.ts's strict reader accepts.
      live: {
        status: current.status,
        publishedDigest: revampSectionsDigest(
          Array.isArray(current.publishedSections)
            ? current.publishedSections
            : [],
        ),
      },
    });
  }
  return out;
}

async function writeChrome(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
  writtenAt: string,
): Promise<RevampApplySnapshot["chrome"]> {
  if (!plan.chrome || !locked.chrome) return null;
  // ★★ THE WHOLE DRAFT IS REPLACED, unlike v1's key-by-key merge: the plan
  //    was written against the whole draft (its digest), so anything that
  //    moved in it was already refused as a conflict.
  const next = sanitizeChromeForSave(plan.chrome.next);
  if (locked.chrome.exists) {
    // The row was locked FOR UPDATE, so this always updates it.
    await db
      .insert(storeChrome)
      .values({ storeId: actor.storeId, draft: next, updatedAt: writtenAt })
      .onConflictDoUpdate({
        target: storeChrome.storeId,
        set: { draft: next, updatedAt: writtenAt },
      });
  } else {
    // ★★ WITH NO ROW THERE WAS NOTHING TO LOCK (READ COMMITTED has no
    //    predicate lock), so the Builder's autosave can insert the store's
    //    first chrome draft while Apply works. Updating that row would lose
    //    an edit the snapshot never saw (rowExisted: false, so Undo would
    //    delete it), so a row found now rolls the whole Apply back instead.
    const inserted = await db
      .insert(storeChrome)
      .values({ storeId: actor.storeId, draft: next, updatedAt: writtenAt })
      .onConflictDoNothing()
      .returning({ storeId: storeChrome.storeId });
    if (!inserted.length) throw revampTargetConflict();
  }
  return {
    rowExisted: locked.chrome.exists,
    before: locked.chrome.exists ? locked.chrome.value : null,
    afterDigest: revampChromeDigest(next),
  };
}

async function writeBrand(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  settings: Record<string, unknown> | null,
): Promise<RevampApplySnapshot["brand"]> {
  if (!plan.brand || !settings) return null;
  const brand = { ...asRecord(settings.brand) };
  const before = {
    tagline: rawText(brand.tagline),
    blurb: rawText(brand.blurb),
  };
  if (plan.brand.tagline !== null) brand.tagline = plan.brand.tagline;
  if (plan.brand.blurb !== null) brand.blurb = plan.brand.blurb;
  await db
    .update(stores)
    .set({ settings: { ...settings, brand } })
    .where(eq(stores.id, actor.storeId));
  return {
    before,
    after: { tagline: rawText(brand.tagline), blurb: rawText(brand.blurb) },
  };
}

async function writeCategories(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
  writtenAt: string,
): Promise<{
  snapshot: RevampApplySnapshotCategory[];
  idsBySlug: Map<string, string>;
}> {
  const snapshot: RevampApplySnapshotCategory[] = [];
  const idsBySlug = new Map(locked.categoryIdsBySlug);
  let nextSort: number | null = null;
  for (const change of plan.categories) {
    if (change.action === "create") {
      if (nextSort === null) {
        const rows = await db.execute(sql`
          select coalesce(max(sort_order), 0)::int as sort from public.categories
          where store_id = ${actor.storeId}::uuid
        `);
        nextSort = Number((rows.rows[0] as { sort?: number })?.sort ?? 0);
      }
      nextSort += 1;
      const [row] = await db
        .insert(categories)
        .values({
          storeId: actor.storeId,
          name: change.name,
          slug: change.slug,
          description: change.description,
          imageUrl: change.imageUrl,
          status: "active",
          sortOrder: nextSort,
        })
        .returning({ id: categories.id, updatedAt: categories.updatedAt });
      if (!row) throw revampTargetConflict();
      idsBySlug.set(change.slug, row.id);
      snapshot.push({
        action: "create",
        id: row.id,
        slug: change.slug,
        before: null,
        afterUpdatedAt: row.updatedAt,
      });
      continue;
    }
    const current = locked.categories.get(change.id);
    if (!current) throw revampTargetConflict();
    const [row] = await db
      .update(categories)
      .set(
        change.action === "hide"
          ? { status: "hidden", updatedAt: writtenAt }
          : {
              name: change.name,
              description: change.description,
              imageUrl: change.imageUrl,
              updatedAt: writtenAt,
            },
      )
      .where(
        and(
          eq(categories.id, change.id),
          eq(categories.storeId, actor.storeId),
        ),
      )
      .returning({ updatedAt: categories.updatedAt });
    if (!row) throw revampTargetConflict();
    snapshot.push({
      action: change.action,
      id: change.id,
      slug: change.slug,
      before: {
        name: current.name,
        description: current.description,
        imageUrl: current.imageUrl,
        status: current.status,
      },
      afterUpdatedAt: row.updatedAt,
    });
  }
  return { snapshot, idsBySlug };
}

async function hideSampleProducts(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  locked: RevampLockedTargets,
): Promise<RevampApplySnapshot["products"]["hidden"]> {
  const ids = plan.products.hide.map((product) => product.id);
  if (!ids.length) return [];
  const rows = await db
    .update(products)
    .set({ status: "draft", publishedAt: null, updatedBy: actor.adminId })
    .where(and(eq(products.storeId, actor.storeId), inArray(products.id, ids)))
    .returning({ id: products.id, updatedAt: products.updatedAt });
  if (rows.length !== ids.length) throw revampTargetConflict();
  return rows.map((row) => ({
    id: row.id,
    statusBefore: locked.hiddenProducts.get(row.id)?.status ?? "published",
    afterUpdatedAt: row.updatedAt,
    publishedAtBefore: locked.hiddenProducts.get(row.id)?.publishedAt ?? null,
  }));
}

/**
 * The merchant's own products, as the product editor would create them:
 * published in their category, featured (the plan's product bands show
 * featured products), the studio photo first and the merchant's photo after
 * it, sizes as options and variants, the price and MRP, and stock untracked
 * so every size can be bought before anyone counts it.
 * ★ SKUs come from the database trigger, as for every product.
 * ★ A CATEGORY THAT DOES NOT EXIST FILES THE PRODUCT WITHOUT ONE. The slug
 *   came from the chat and was never checked against the store, so it may
 *   name no category the store has or the plan creates; the product still
 *   goes on the shop, and `notes` says which one and why.
 */
async function createProducts(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
  idsBySlug: Map<string, string>,
  writtenAt: string,
  notes: string[],
): Promise<RevampApplySnapshot["products"]["created"]> {
  const out: RevampApplySnapshot["products"]["created"] = [];
  for (const product of plan.products.create) {
    const resolved = resolveOptionRows(product.options, variantRows(product));
    // Validated when the plan was read; never reached with a readable plan.
    if ("error" in resolved) throw revampTargetConflict();
    const categoryId = product.categorySlug
      ? (idsBySlug.get(product.categorySlug) ?? null)
      : null;
    if (product.categorySlug && !categoryId) {
      notes.push(
        `${product.name.trim()} went on your shop without a category, because your store has no "${product.categorySlug}" category.`,
      );
      logWarn("mink.revamp: product filed without its category", {
        storeId: actor.storeId,
        revampId: plan.revampId,
        categorySlug: product.categorySlug,
      });
    }
    const images = [
      ...new Set(
        [product.imageUrl, product.sourceImageUrl].filter(
          (url): url is string => !!url,
        ),
      ),
    ];
    const name = product.name.trim();
    const description = product.description.trim();
    const [row] = await db
      .insert(products)
      .values({
        storeId: actor.storeId,
        name,
        slug: product.slug,
        description: description || null,
        categoryId,
        basePrice: listPrice(product.price, product.mrp),
        sellingPrice: product.price,
        imageUrl: images[0] ?? null,
        images,
        status: "published",
        // ★★ FEATURED, because the plan's product bands read that flag: the
        //    compiler gives every featured_products section source "featured"
        //    and the preview's After frame shows these products in it. An
        //    unfeatured insert leaves the band empty once published (or shows
        //    older products), which is not the page the merchant approved.
        //    Undo removes or unpublishes the row, so nothing else is touched.
        featured: true,
        options: resolved.options,
        seoTitle: name.slice(0, 70),
        seoDescription: description.slice(0, 160) || null,
        publishedAt: writtenAt,
        createdBy: actor.adminId,
        updatedBy: actor.adminId,
        trackInventory: false,
        allowBackorder: false,
        // sku / sku_no are NOT NULL but owned by the BEFORE-INSERT trigger.
      } as typeof products.$inferInsert)
      .returning({ id: products.id, updatedAt: products.updatedAt });
    if (!row) throw revampTargetConflict();
    // ★ One size is the product itself; several sizes (or any option axis)
    //   are variants, each untracked like its product (the column defaults
    //   to tracked, which would make every size read as sold out).
    const variants =
      resolved.options.length || resolved.variants.length > 1
        ? resolved.variants
        : [];
    if (variants.length) {
      await db.insert(productVariants).values(
        variants.map((variant, index) => ({
          productId: row.id,
          storeId: actor.storeId,
          name: variant.name,
          basePrice: listPrice(variant.price, variant.mrp),
          sellingPrice: variant.price,
          optionValues: variant.option_values,
          sortOrder: index,
          trackInventory: false,
          allowBackorder: false,
        })) as (typeof productVariants.$inferInsert)[],
      );
    }
    out.push({ id: row.id, slug: product.slug, afterUpdatedAt: row.updatedAt });
  }
  return out;
}

/**
 * ★★ The photos this card puts on the store join the Media Library (ops-1).
 *   Every revamp photo is filed hidden (image-store.ts), because a revamp
 *   that is stopped or fails charges nothing and its photos are not the
 *   merchant's to pick; applying the card files the ones it shows (its
 *   photos, category photos and studio product photos) as Mink's own
 *   pictures. ★ Only this store's revamp objects and only rows still hidden:
 *   a merchant's own photo, and a phone crop (a prepared copy, never in
 *   these lists), are left as they are. In Apply's transaction, so a rolled
 *   back Apply reveals nothing.
 */
async function revealRevampPhotos(
  db: Db,
  actor: MinkActorContext,
  plan: RevampStoredPlan,
): Promise<void> {
  const urls = [
    ...new Set(
      [
        ...plan.photos.map((photo) => photo.url),
        ...plan.categories.flatMap((change) =>
          change.action !== "hide" && change.imageUrl ? [change.imageUrl] : [],
        ),
        ...plan.products.create.map((product) => product.imageUrl),
      ].filter((url): url is string => typeof url === "string" && url !== ""),
    ),
  ];
  if (urls.length === 0) return;
  await db
    .update(mediaAssets)
    .set({ source: REVAMP_REVEALED_MEDIA_SOURCE })
    .where(
      and(
        eq(mediaAssets.storeId, actor.storeId),
        eq(mediaAssets.source, REVAMP_HIDDEN_MEDIA_SOURCE),
        inArray(mediaAssets.url, urls),
        like(
          mediaAssets.path,
          `stores/${actor.storeId}/${REVAMP_IMAGE_FOLDER}/%`,
        ),
      ),
    );
}

/**
 * Record the apply on the revamp's job, in the same transaction as the
 * writes. ★ The card's draft id IS the revamp's id, so either matches; a job
 * that is gone never blocks the apply, it only costs Undo.
 * ★★ Only a job not yet applied is written (lockRevampJob refused the rest),
 *    so an earlier Apply's snapshot, which Undo restores from, is never
 *    replaced. A job the lock DID find that the record now misses would mean
 *    a store change no snapshot describes, so that throws and rolls the whole
 *    Apply back instead.
 */
export async function recordRevampApplied(
  db: Db,
  actor: MinkActorContext,
  input: {
    revampId: string;
    draftId: string;
    snapshot: RevampApplySnapshot;
    job: RevampJobLock;
  },
): Promise<boolean> {
  const rows = await db
    .update(minkRevamps)
    .set({
      applySnapshot: input.snapshot,
      appliedAt: input.snapshot.appliedAt,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(minkRevamps.storeId, actor.storeId),
        or(
          eq(minkRevamps.id, input.revampId),
          eq(minkRevamps.draftId, input.draftId),
        ),
        inArray(minkRevamps.status, ["ready", "superseded"]),
        isNull(minkRevamps.appliedAt),
      ),
    )
    .returning({ id: minkRevamps.id });
  if (!rows.length) {
    logWarn("mink.revamp: applied without its job", {
      revampId: input.revampId,
      draftId: input.draftId,
      jobFound: input.job.found,
    });
    if (input.job.found) throw revampTargetConflict();
  }
  return rows.length > 0;
}

/** One sentence for the append-only audit row; never model-authored text. */
export function revampAuditDetail(plan: RevampStoredPlan): string {
  const created = plan.pages.filter((page) => page.create).length;
  const parts = [
    `${countLabel(plan.pages.length, "page")} saved to the private Website Builder draft${created ? ` (${created} new)` : ""}`,
    countLabel(plan.photos.length, "new photo"),
  ];
  if (plan.chrome) parts.push("header, footer and look saved to the draft");
  if (plan.categories.length) {
    parts.push(countLabel(plan.categories.length, "category change"));
  }
  if (plan.products.hide.length) {
    parts.push(
      `${countLabel(plan.products.hide.length, "sample product")} unpublished`,
    );
  }
  if (plan.products.create.length) {
    parts.push(
      `${countLabel(plan.products.create.length, "product")} added to the shop`,
    );
  }
  if (plan.brand) parts.push("store tagline or description updated");
  return `Approved storefront redesign applied: ${parts.join("; ")}. No page was published.`;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function hasProductChanges(plan: RevampStoredPlan): boolean {
  return plan.products.hide.length > 0 || plan.products.create.length > 0;
}

/** v1's category checkpoint, restated for the same reason it exists there. */
function categoryCheckpoint(
  change: Exclude<PersonalizationStoredCategory, { action: "create" }>,
  values: {
    version: string | null;
    name: string | null;
    description: string | null;
    imageUrl: string | null;
  },
) {
  return change.action === "hide"
    ? { id: change.id, version: values.version, name: values.name }
    : {
        id: change.id,
        version: values.version,
        name: values.name,
        description: values.description,
        imageUrl: values.imageUrl,
      };
}

/**
 * ★ ONE SHAPE FOR EVERY VERSION COMPARED (v1's rule, restated because v1's
 *   is private): the snapshot recorded versions through Drizzle and the locks
 *   read them with raw SQL; both become one ISO form with every microsecond
 *   kept (never through `Date`, which drops them).
 */
export function normalizeTimestamp(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      String(value).trim(),
    );
  if (!match) return String(value);
  const fraction = (match[3] ?? "").padEnd(7, "0").slice(0, 7);
  let zone = match[4] ?? "Z";
  if (zone === "+00" || zone === "+00:00" || zone === "+0000") zone = "Z";
  return `${match[1]}T${match[2]}${fraction}${zone}`;
}

function nullableText(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length > 0);
}

function rawText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
