// ---------------------------------------------------------------------------
// Mink storefront revamp: fitting a plan to its budget, and assembling the
// stored plan the review card applies (docs/mink-storefront-revamp.md,
// sections 6 and 9). Two of the runner's ports (ports.ts):
//
//   fitRevampPlanToBudget  a paid revamp's compiled plan, trimmed to what its
//                          budget covers BEFORE any photograph is drawn, the
//                          most visible work first;
//   assembleRevampPlan     the compiled plan, the stored photographs and the
//                          merchant's products, turned into plan version 2:
//                          every photo slot resolved to a stored URL, every
//                          lock copied from the snapshot, the charge estimated.
//
// ★ NO I/O, BUT SERVER-SIDE. The proposed page digest is `revampSectionsDigest`
//   (digests.ts), the one hash the apply path recomputes under its locks, and
//   it hashes with node:crypto. A second, client-safe copy of that hash would
//   be a conflict on every apply, so this module imports it instead (the same
//   choice digests.ts made). Nothing here reads a database, a file or the clock.
// ---------------------------------------------------------------------------

import {
  EMPTY_DESIGN_OVERRIDES,
  type StorefrontDesignOverrides,
} from "@/lib/chrome/design";
import {
  sanitizeChromeForSave,
  type StoreChrome,
  type StorefrontAppearance,
} from "@/lib/chrome/types";
import { composeVariantName } from "@/lib/products/options";
import {
  SECTION_TYPE_META,
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import {
  categorySlugFromName,
  type PersonalizationStoredCategory,
  type PersonalizationStoredPhoto,
  type PersonalizationStoredProduct,
} from "../storefront-personalization-contract";
import {
  countLabel,
  REVAMP_LIMITS,
  REVAMP_PRICES,
  REVAMP_SCHEMA_VERSION,
  REVAMP_SLOT_PREFIX,
  type RevampChargeBasis,
  type RevampCreditBreakdown,
  type RevampPhotoOutcome,
  type RevampPlanBasis,
  type RevampPlannedPage,
  type RevampRequest,
  type RevampSitePlan,
  type RevampSlotBinding,
  type RevampSnapshot,
  type RevampSnapshotPage,
  type RevampStoredImage,
  type RevampStoredPage,
  type RevampStoredPlan,
  type RevampStoredProductCreate,
} from "./contract";
import { revampSectionsDigest } from "./digests";
import {
  clipText,
  normalizeRevampPageSlug,
  revampCategoryChangeKey,
  revampExistingProducts,
  revampNewProductSlugs,
  sanitizeShotId,
} from "./site-compiler";

type Path = ReadonlyArray<string | number>;
type Json = Record<string, unknown>;

/** The reason every budget drop gives, in the merchant's words. */
const NOT_ENOUGH = "Not enough Mink credits left this time.";

/**
 * A shot's phone crop is stored under the shot id with this suffix.
 * ★ image-store.ts's REVAMP_PHONE_SUFFIX, restated because that module is
 *   storage code; assemble.test.ts pins the two equal.
 */
export const REVAMP_PHONE_CROP_SUFFIX = "~phone";

/** The binding page of a category's photograph (site-compiler.ts). */
const CATEGORY_PAGE = "@category";

/** Two frames are one shape within 3% (the compiler's tolerance). */
const SAME_SHAPE_TOLERANCE = 0.03;

const MAX_EXPLANATION = 1000;

// ---------------------------------------------------------------------------
// Small shared rules (checks.ts uses these too).
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The value at `path` inside `root`, or undefined. */
export function revampValueAt(root: unknown, path: Path): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (Array.isArray(node) && typeof key === "number") node = node[key];
    else if (isRecord(node) && typeof key === "string") node = node[key];
    else return undefined;
  }
  return node;
}

/** Sets the value at `path` when its parent exists; false when it does not. */
export function revampSetValueAt(
  root: unknown,
  path: Path,
  value: unknown,
): boolean {
  if (!path.length) return false;
  const parent = revampValueAt(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (Array.isArray(parent) && typeof key === "number") {
    if (key < 0 || key >= parent.length) return false;
    parent[key] = value;
    return true;
  }
  if (isRecord(parent) && typeof key === "string") {
    parent[key] = value;
    return true;
  }
  return false;
}

export function isRevampSlotRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(REVAMP_SLOT_PREFIX);
}

function slotRef(shotId: string): string {
  return `${REVAMP_SLOT_PREFIX}${shotId}`;
}

/**
 * True when a section can be published as it stands. ★ The publish-mode
 * validator is the one rule for "cannot render without this image": a hero
 * with a headline survives a cleared photo, a gallery left with one picture
 * does not.
 */
export function revampSectionRenders(section: PageSectionItem): boolean {
  return !("error" in validateSections([section], { mode: "publish" }));
}

/** True when a design sets any colour, font or shape of its own. */
export function revampDesignHasOverride(
  design: StorefrontDesignOverrides | null | undefined,
): boolean {
  if (!design) return false;
  return (
    Object.values(design.palette ?? {}).some(
      (value) => typeof value === "string" && value !== "",
    ) ||
    !!design.fonts?.body ||
    !!design.fonts?.display ||
    Object.values(design.shape ?? {}).some((value) => typeof value === "number")
  );
}

/** The snapshot page a planned page writes over, or null for a new page. */
export function revampSnapshotPageFor(
  snapshot: Pick<RevampSnapshot, "pages">,
  page: { slug: string; pageId: string | null; create: boolean },
): RevampSnapshotPage | null {
  if (page.create) return null;
  return (
    (page.pageId
      ? snapshot.pages.find((p) => p.id === page.pageId)
      : undefined) ??
    snapshot.pages.find((p) => p.slug === page.slug) ??
    null
  );
}

/**
 * True for a section the merchant made that the revamp kept: the snapshot
 * page has it by id and it is the merchant's (custom code always is, as the
 * compiler treats it).
 */
export function isRevampMerchantSection(
  section: PageSectionItem,
  snapshotPage: RevampSnapshotPage | null,
): boolean {
  if (!snapshotPage) return false;
  if (!snapshotPage.sections.some((s) => s.id === section.id)) return false;
  return (
    snapshotPage.owners[section.id] === "merchant" ||
    section.type === "custom_code"
  );
}

/** Every `*_url` field of a section config, with its path. */
export function revampMediaFields(
  config: unknown,
): Array<{ path: Array<string | number>; url: string }> {
  const out: Array<{ path: Array<string | number>; url: string }> = [];
  const walk = (node: unknown, path: Array<string | number>, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, [...path, i], depth + 1));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        if (key.endsWith("_url") && value.trim()) {
          out.push({ path: [...path, key], url: value.trim() });
        }
        continue;
      }
      walk(value, [...path, key], depth + 1);
    }
  };
  walk(config, [], 0);
  return out;
}

/** What a page's sections change against the store's page today. */
export function revampPageChanges(
  sections: readonly PageSectionItem[],
  snapshotPage: RevampSnapshotPage | null,
  newPhotoUrls: ReadonlySet<string>,
): RevampStoredPage["changes"] {
  const before = new Set((snapshotPage?.sections ?? []).map((s) => s.id));
  const after = new Set(sections.map((s) => s.id));
  const kept = sections.filter((s) => before.has(s.id)).length;
  const photos = new Set<string>();
  for (const section of sections) {
    for (const field of revampMediaFields(section.config)) {
      if (newPhotoUrls.has(field.url)) photos.add(field.url);
    }
  }
  return {
    added: sections.length - kept,
    removed: [...before].filter((id) => !after.has(id)).length,
    kept,
    photos: photos.size,
  };
}

/** "Home page", "About page": how the card names a page. */
export function revampPageName(slug: string, title: string): string {
  if (slug === "") return "Home page";
  const name = title.trim() || titleFromSlug(slug);
  return /\bpage$/i.test(name) ? name : `${name} page`;
}

function titleFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "New";
}

/** A section's type as the merchant reads it, mid-sentence ("gallery"). */
export function revampSectionLabel(section: PageSectionItem): string {
  const meta = (
    SECTION_TYPE_META as Record<string, { label: string } | undefined>
  )[section.type];
  const label = meta?.label?.trim() || "section";
  return label.length > 1 && label[1] === label[1].toLowerCase()
    ? label[0].toLowerCase() + label.slice(1)
    : label;
}

/** The binding of the homepage's opening photograph: its first enabled section that has one. */
export function revampOpeningBinding(
  plan: Pick<RevampSitePlan, "pages" | "bindings">,
): RevampSlotBinding | null {
  const home = plan.pages.find((page) => page.slug === "");
  for (const section of home?.sections ?? []) {
    if (section.enabled === false) continue;
    const binding = plan.bindings.find(
      (b) => b.pageSlug === "" && b.sectionId === section.id,
    );
    if (binding) return binding;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The estimate.
// ---------------------------------------------------------------------------

/** What items cost at today's prices: the one price list every charge uses. */
function priceRevampItems(items: {
  pages: number;
  photos: number;
  design: boolean;
  chrome: boolean;
  categories: number;
  productPhotos: number;
}): RevampCreditBreakdown {
  const pages = items.pages * REVAMP_PRICES.page;
  const photos = items.photos * REVAMP_PRICES.photo;
  const design = items.design ? REVAMP_PRICES.design : 0;
  const chrome = items.chrome ? REVAMP_PRICES.chrome : 0;
  const categories = items.categories * REVAMP_PRICES.category;
  const productPhotos = items.productPhotos * REVAMP_PRICES.productPhoto;
  return {
    pages,
    photos,
    design,
    chrome,
    categories,
    productPhotos,
    total: pages + photos + design + chrome + categories + productPhotos,
  };
}

/** The card's credits from its itemised charge (checks.ts recounts with this). */
export function revampCreditsFromCharges(
  charges: RevampChargeBasis,
): RevampCreditBreakdown {
  return priceRevampItems({
    pages: charges.pages.length,
    photos: charges.photoUrls.length,
    design: charges.design,
    chrome: charges.chrome,
    categories: charges.categories,
    productPhotos: charges.productPhotoKeys.length,
  });
}

/**
 * The confirmed category changes this revamp makes: those of a refinement's
 * that its parent already made (the compiler finds them by key) are not.
 */
function newCategoryChanges(
  basis: RevampPlanBasis | undefined,
  request: Pick<RevampRequest, "categories">,
): number {
  return Math.max(
    0,
    request.categories.length - (basis?.carried?.categories ?? 0),
  );
}

/**
 * Whether this revamp takes a product's studio photo, and who pays for it:
 *   none     a product the store already has: it is not created, so the
 *            photo would show nowhere (known-1b);
 *   free     a refinement's parent's product, when the refinement is not
 *            about the products (money-1): the parent's work, so never
 *            charged again. ★ Still taken: a refinement of an unapplied
 *            parent is what creates the product, which would otherwise get
 *            the merchant's own photo instead. ★★ Taken as the parent's own
 *            studio photo (products.ts carries it over, f-5), and drawn only
 *            when the parent has none to carry, since a free photo drawn
 *            again is one StoreMink pays for twice;
 *   charged  every other product with a photo.
 */
type ProductPhotoRule = "none" | "free" | "charged";

function productPhotoRule(
  basis: RevampPlanBasis | undefined,
  request: Pick<RevampRequest, "refineScope">,
): (key: string) => ProductPhotoRule {
  const existing = new Set(basis?.existingProductKeys ?? []);
  const carried = new Set(basis?.carried?.products ?? []);
  const inScope = request.refineScope?.products === true;
  return (key) => {
    if (existing.has(key)) return "none";
    return !inScope && carried.has(key) ? "free" : "charged";
  };
}

/**
 * The products whose studio photo a revamp with no budget takes (a free
 * revamp, an unmetered plan), in request order: every one with a photo, but
 * never one the store already has. A budgeted revamp gets the same set from
 * `fitRevampPlanToBudget`, less what its budget left out.
 */
export function revampProductPhotoKeys(
  plan: Pick<RevampSitePlan, "basis">,
  request: Pick<RevampRequest, "products" | "refineScope">,
): string[] {
  const rule = productPhotoRule(plan.basis, request);
  return request.products
    .filter((product) => !!product.photoUrl && rule(product.key) !== "none")
    .map((product) => product.key);
}

/**
 * The products whose studio photo a refinement carries over from its parent
 * (products.ts takes the parent's stored photo for each), in request order.
 * ★ Exactly those `productPhotoRule` prices as free, from the one rule, so a
 *   photo carried over is never charged and a free one is never drawn twice
 *   while the parent has it.
 */
export function revampCarriedProductPhotoKeys(
  plan: Pick<RevampSitePlan, "basis">,
  request: Pick<RevampRequest, "products" | "refineScope">,
): string[] {
  const rule = productPhotoRule(plan.basis, request);
  return request.products
    .filter((product) => !!product.photoUrl && rule(product.key) === "free")
    .map((product) => product.key);
}

/**
 * What a plan costs at today's prices, before any photo is drawn. ★ The
 * header and footer are charged once on every revamp (the plan always
 * rewrites the menus), the design only when it changes a colour, font or
 * shape, and the merchant's confirmed category changes whatever the plan
 * says (they come from the request). ★★ A refinement is charged only for
 * what it makes (money-1): the pages, photographs, look, chrome, category
 * changes and product photos it carries over from its parent are the
 * parent's work and cost nothing again. A plan with no basis (compiled
 * before it existed) is charged as it always was.
 */
export function estimateRevampCredits(
  plan: Pick<RevampSitePlan, "pages" | "shots" | "design" | "basis">,
  input: {
    request: Pick<RevampRequest, "categories" | "refineScope">;
    productPhotoKeys: readonly string[];
  },
): RevampCreditBreakdown {
  const carried = plan.basis?.carried ?? null;
  const carriedPages = new Set(carried?.pages ?? []);
  const carriedShots = new Set(carried?.shots ?? []);
  const rule = productPhotoRule(plan.basis, input.request);
  return priceRevampItems({
    pages: plan.pages.filter((page) => !carriedPages.has(page.slug)).length,
    photos: plan.shots.filter((shot) => !carriedShots.has(shot.id)).length,
    design: revampDesignHasOverride(plan.design) && !carried?.design,
    chrome: !carried?.chrome,
    categories: newCategoryChanges(plan.basis, input.request),
    productPhotos: new Set(
      input.productPhotoKeys.filter((key) => rule(key) === "charged"),
    ).size,
  });
}

/**
 * ★★ THE MOST A PAID REVAMP'S FIXED PART CAN COST, before it is planned:
 *   what `fitRevampPlanToBudget` reserves first and never drops (the
 *   homepage's words, the header and footer, the opening photograph and each
 *   category change it makes). The start tool refuses a paid budget below
 *   it, since a card whose fixed part the budget cannot pay fails at the
 *   charge, after every paid call. Never shown to the merchant or the model.
 * ★★ A REFINEMENT RESERVES ONLY WHAT IT DOES NOT CARRY (f-6), so its
 *   ceiling comes from the request and the parent's compiled plan by the
 *   carry rules the compiler records in `basis.carried` (site-compiler.ts):
 *   the homepage's words when the refinement writes the homepage
 *   (`revampPageScope`), the header and footer when it changes the words,
 *   the layout or the look, the opening photograph when it is redrawn or the
 *   homepage is written again, and only the category changes the parent did
 *   not make, matched by key. A full revamp's floor for every refinement
 *   refused a store with enough credits for "make it warmer".
 * ★ A ceiling: what the compile may still find unchanged (a header and
 *   footer the model leaves as they were, a rewritten homepage that keeps
 *   its opening photograph) is counted.
 */
export function revampFixedCreditCeiling(
  request: Pick<RevampRequest, "kind" | "categories" | "refineScope">,
  parent: Pick<RevampSitePlan, "pages" | "bindings" | "basis"> | null,
): number {
  const scope = request.refineScope;
  if (request.kind !== "refine" || !scope || !parent) {
    return (
      REVAMP_PRICES.page +
      REVAMP_PRICES.chrome +
      REVAMP_PRICES.photo +
      request.categories.length * REVAMP_PRICES.category
    );
  }
  // revampPageScope: no new words and no new layout copy every page as it
  // was; otherwise the pages named, or all of them, are written again.
  const named = scope.pages
    ? new Set(scope.pages.map(normalizeRevampPageSlug))
    : null;
  const writesHome =
    (scope.copy || scope.layout) &&
    (named ? named.has("") : parent.pages.some((page) => page.slug === ""));
  // The header and footer are the parent's only when the words, the layout
  // and the look all are (the compiler's chromeFromPrevious).
  const chrome = scope.copy || scope.layout || scope.design;
  // A homepage copied as it was keeps the parent's opening photograph unless
  // it is redrawn, matched the way the compiler matches a redraw.
  const opening = writesHome ? null : revampOpeningBinding(parent);
  const redraws = (shotId: string) =>
    scope.photos === "all" ||
    (scope.photos ?? []).some((id) => (sanitizeShotId(id) ?? id) === shotId);
  const openingPhoto =
    writesHome || (opening !== null && redraws(opening.shotId));
  return (
    (writesHome ? REVAMP_PRICES.page : 0) +
    (chrome ? REVAMP_PRICES.chrome : 0) +
    (openingPhoto ? REVAMP_PRICES.photo : 0) +
    newRefinementCategoryChanges(request, parent.basis) * REVAMP_PRICES.category
  );
}

/**
 * The request's category changes its parent did not make, each matched once
 * against the parent's keys (the compiler's own count, which it does not
 * export). ★ A parent that recorded no keys made none this can prove.
 */
function newRefinementCategoryChanges(
  request: Pick<RevampRequest, "categories">,
  basis: RevampPlanBasis | undefined,
): number {
  const left = new Map<string, number>();
  for (const key of basis?.categoryChanges ?? []) {
    left.set(key, (left.get(key) ?? 0) + 1);
  }
  let made = 0;
  for (const change of request.categories) {
    const key = revampCategoryChangeKey(change);
    const n = left.get(key) ?? 0;
    if (n > 0) left.set(key, n - 1);
    else made += 1;
  }
  return made;
}

// ---------------------------------------------------------------------------
// Fitting a paid revamp to its budget.
// ---------------------------------------------------------------------------

function aspectOf(frame: RevampSlotBinding["frame"]): number {
  if (frame && frame.aspect > 0) return frame.aspect;
  return frame && frame.height > 0 ? frame.width / frame.height : 0;
}

function sameShape(a: number, b: number): boolean {
  return a > 0 && b > 0 && Math.abs(a / b - 1) <= SAME_SHAPE_TOLERANCE;
}

function sectionOf(
  plan: RevampSitePlan,
  binding: Pick<RevampSlotBinding, "pageSlug" | "sectionId">,
): PageSectionItem | null {
  const page = plan.pages.find((p) => p.slug === binding.pageSlug);
  return page?.sections.find((s) => s.id === binding.sectionId) ?? null;
}

function removeSection(
  plan: RevampSitePlan,
  pageSlug: string,
  sectionId: string,
): void {
  const page = plan.pages.find((p) => p.slug === pageSlug);
  if (page) page.sections = page.sections.filter((s) => s.id !== sectionId);
  plan.bindings = plan.bindings.filter(
    (b) => !(b.pageSlug === pageSlug && b.sectionId === sectionId),
  );
}

function removePage(plan: RevampSitePlan, slug: string): void {
  plan.pages = plan.pages.filter((p) => p.slug !== slug);
  plan.bindings = plan.bindings.filter((b) => b.pageSlug !== slug);
}

/** A shot no field shows is never drawn, so it is never charged either. */
function dropUnboundShots(plan: RevampSitePlan): void {
  const bound = new Set(plan.bindings.map((b) => b.shotId));
  plan.shots = plan.shots.filter((shot) => bound.has(shot.id));
}

function uniqueShotIds(bindings: readonly RevampSlotBinding[]): string[] {
  return [...new Set(bindings.map((b) => b.shotId))];
}

/** The homepage's shots in the order its sections show them. */
function homeShotIds(plan: RevampSitePlan): string[] {
  const home = plan.pages.find((p) => p.slug === "");
  const ordered: RevampSlotBinding[] = [];
  for (const section of home?.sections ?? []) {
    ordered.push(
      ...plan.bindings.filter(
        (b) => b.pageSlug === "" && b.sectionId === section.id,
      ),
    );
  }
  return uniqueShotIds(ordered);
}

/**
 * Takes one homepage photograph out of the plan. Each field it filled shows
 * the opening photograph instead when the frames are one shape; otherwise
 * the field is cleared, and a section that cannot be published without it
 * goes too. ★ The opening photograph itself is never dropped.
 */
function dropShot(
  plan: RevampSitePlan,
  shotId: string,
  opening: RevampSlotBinding | null,
): void {
  const reuse = opening && opening.shotId !== shotId ? opening : null;
  for (const binding of plan.bindings.filter((b) => b.shotId === shotId)) {
    const section =
      binding.pageSlug === CATEGORY_PAGE ? null : sectionOf(plan, binding);
    if (!section) {
      plan.bindings = plan.bindings.filter((b) => b !== binding);
      continue;
    }
    if (reuse && sameShape(aspectOf(binding.frame), aspectOf(reuse.frame))) {
      binding.shotId = reuse.shotId;
      revampSetValueAt(section.config, binding.path, slotRef(reuse.shotId));
      if (
        binding.phonePath &&
        isRevampSlotRef(revampValueAt(section.config, binding.phonePath))
      ) {
        revampSetValueAt(
          section.config,
          binding.phonePath,
          slotRef(reuse.shotId),
        );
      }
      continue;
    }
    revampSetValueAt(section.config, binding.path, "");
    if (binding.phonePath) {
      revampSetValueAt(section.config, binding.phonePath, "");
    }
    plan.bindings = plan.bindings.filter((b) => b !== binding);
    if (!revampSectionRenders(section)) {
      removeSection(plan, binding.pageSlug, section.id);
    }
  }
  plan.shots = plan.shots.filter((shot) => shot.id !== shotId);
}

function yourPageLabel(page: RevampPlannedPage): string {
  return `Your ${revampPageName(page.slug, page.title)}`;
}

/**
 * A paid revamp's plan cut to what its budget covers, spent in the order a
 * shopper notices it (build spec section 6): the homepage's words, the
 * design, the header and footer, the confirmed categories with their
 * photographs, the homepage's photographs (the opening one first), each
 * other page with its photographs in plan order, then studio photos of the
 * merchant's products in request order. Everything dropped is listed in
 * `plan.skipped` in the merchant's words.
 *
 * ★ THE HOMEPAGE'S WORDS AND OPENING PHOTOGRAPH, THE HEADER AND FOOTER AND
 *   THE CONFIRMED CATEGORIES ARE NEVER DROPPED: without them there is no
 *   revamp to review, and the categories are the merchant's own confirmed
 *   request, which the plan cannot edit. The tool that starts a paid revamp
 *   refuses a balance below that floor, so the cap holds in practice.
 * ★★ WHAT A REFINEMENT CARRIES OVER IS NEITHER CHARGED NOR DROPPED
 *   (money-1): its parent's pages, photographs, look, chrome and category
 *   changes are already made, so they are bought up front at no cost, and a
 *   carried page is never removed for want of credits; its parent's
 *   products' studio photos are taken at no cost (see `productPhotoRule`).
 *   Only what the refinement makes competes for the budget.
 * ★ The budget is capped at REVAMP_LIMITS.maxCredits, the draft ceiling.
 */
export function fitRevampPlanToBudget(
  plan: RevampSitePlan,
  input: { request: RevampRequest; budget: number },
): { plan: RevampSitePlan; productPhotoKeys: string[] } {
  const next = clone(plan);
  const budget = Number.isFinite(input.budget) ? input.budget : 0;
  const cap = Math.max(0, Math.min(budget, REVAMP_LIMITS.maxCredits));
  let spent = 0;
  const fits = (cost: number) => spent + cost <= cap;
  const bought = new Set<string>();
  const skipped: RevampSitePlan["skipped"] = [];
  // A binding to a section the plan no longer has would be charged and never drawn.
  next.bindings = next.bindings.filter(
    (b) => b.pageSlug === CATEGORY_PAGE || sectionOf(next, b) !== null,
  );
  dropUnboundShots(next);

  const carried = next.basis?.carried ?? null;
  const carriedPages = new Set(carried?.pages ?? []);
  for (const id of carried?.shots ?? []) bought.add(id);

  // ★ What is never dropped is reserved FIRST (the homepage's words, the
  //   header and footer, the confirmed categories, the opening photograph),
  //   so a cheaper item bought earlier in the order can never push the total
  //   past the budget once the fixed costs are added.
  const opening = revampOpeningBinding(next);
  if (next.pages.some((p) => p.slug === "" && !carriedPages.has(""))) {
    spent += REVAMP_PRICES.page;
  }
  if (!carried?.chrome) spent += REVAMP_PRICES.chrome;
  spent +=
    newCategoryChanges(next.basis, input.request) * REVAMP_PRICES.category;
  if (opening && !bought.has(opening.shotId)) {
    spent += REVAMP_PRICES.photo;
    bought.add(opening.shotId);
  }

  // The design (a refinement's carried look is its parent's).
  if (revampDesignHasOverride(next.design) && !carried?.design) {
    if (fits(REVAMP_PRICES.design)) {
      spent += REVAMP_PRICES.design;
    } else {
      next.design = clone(EMPTY_DESIGN_OVERRIDES);
      skipped.push({ label: "Your new colours and fonts", reason: NOT_ENOUGH });
    }
  }

  // The categories' photographs ride with the categories.
  let categoryDropped = 0;
  for (const id of uniqueShotIds(
    next.bindings.filter((b) => b.pageSlug === CATEGORY_PAGE),
  )) {
    if (bought.has(id)) continue;
    if (fits(REVAMP_PRICES.photo)) {
      spent += REVAMP_PRICES.photo;
      bought.add(id);
      continue;
    }
    next.bindings = next.bindings.filter(
      (b) => !(b.shotId === id && b.pageSlug === CATEGORY_PAGE),
    );
    categoryDropped += 1;
  }
  if (categoryDropped) {
    skipped.push({
      label:
        categoryDropped === 1
          ? "A new photo for 1 category"
          : `New photos for ${categoryDropped} categories`,
      reason: NOT_ENOUGH,
    });
  }

  // The homepage's other photographs, in the order its sections show them.
  const homeIds = homeShotIds(next);
  for (const id of homeIds) {
    // ★ A shot whose only section went with an earlier drop is not drawn.
    if (bought.has(id) || !next.bindings.some((b) => b.shotId === id)) {
      continue;
    }
    if (fits(REVAMP_PRICES.photo)) {
      spent += REVAMP_PRICES.photo;
      bought.add(id);
      continue;
    }
    dropShot(next, id, opening);
  }
  // Counted after the loop: a shot lost with its section is a photo they lose too.
  const homeDropped = homeIds.filter((id) => !bought.has(id)).length;
  if (homeDropped) {
    skipped.push({
      label: `${countLabel(homeDropped, "new photograph")} on your homepage`,
      reason: NOT_ENOUGH,
    });
  }

  // Every other page with its photographs, in plan order.
  for (const page of next.pages.filter((p) => p.slug !== "")) {
    const ids = uniqueShotIds(
      next.bindings.filter((b) => b.pageSlug === page.slug),
    ).filter((id) => !bought.has(id));
    if (carriedPages.has(page.slug)) {
      // ★ A carried page stays whatever the budget: only a photograph the
      //   refinement redraws on it is bought, or left out.
      let dropped = 0;
      for (const id of ids) {
        if (!next.bindings.some((b) => b.shotId === id)) continue;
        if (fits(REVAMP_PRICES.photo)) {
          spent += REVAMP_PRICES.photo;
          bought.add(id);
          continue;
        }
        dropShot(next, id, opening);
        dropped += 1;
      }
      if (dropped) {
        skipped.push({
          label: `${countLabel(dropped, "new photograph")} on your ${revampPageName(page.slug, page.title)}`,
          reason: NOT_ENOUGH,
        });
      }
      continue;
    }
    const cost = REVAMP_PRICES.page + ids.length * REVAMP_PRICES.photo;
    if (fits(cost)) {
      spent += cost;
      for (const id of ids) bought.add(id);
      continue;
    }
    removePage(next, page.slug);
    skipped.push({ label: yourPageLabel(page), reason: NOT_ENOUGH });
  }

  // Studio photos of the merchant's products, in request order. ★ One the
  // store has is not taken at all, and a parent's product a refinement
  // leaves alone is taken at no charge; neither is ever listed as dropped,
  // since nothing was left out.
  const rule = productPhotoRule(next.basis, input.request);
  const productPhotoKeys: string[] = [];
  let productDropped = 0;
  for (const product of input.request.products) {
    if (!product.photoUrl) continue;
    const pays = rule(product.key);
    if (pays === "none") continue;
    if (pays === "free") {
      productPhotoKeys.push(product.key);
      continue;
    }
    if (fits(REVAMP_PRICES.productPhoto)) {
      spent += REVAMP_PRICES.productPhoto;
      productPhotoKeys.push(product.key);
    } else {
      productDropped += 1;
    }
  }
  if (productDropped) {
    skipped.push({
      label:
        productDropped === 1
          ? "A studio photo of 1 product"
          : `Studio photos of ${productDropped} products`,
      reason:
        "Not enough Mink credits left this time; your own photos are used.",
    });
  }

  dropUnboundShots(next);
  next.skipped = [...(next.skipped ?? []), ...skipped];
  return { plan: next, productPhotoKeys };
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

export interface RevampAssembleInput {
  revampId: string;
  request: RevampRequest;
  snapshot: RevampSnapshot;
  plan: RevampSitePlan;
  images: RevampStoredImage[];
  outcomes: RevampPhotoOutcome[];
  productFailures: Array<{ key: string; reason: string }>;
  free: boolean;
  /** The requester holds Branding manage (ports.ts says why it matters). */
  canChangeBrand: boolean;
}

/** Why a card leaves the store's tagline and footer description alone. */
export const REVAMP_BRAND_PERMISSION_NOTE =
  "Your store tagline and footer description were left as they are, because changing them needs Branding manage permission.";

/** The alt text field beside an image field ("image_url" -> "image_alt"). */
function altPathFor(path: Path): Array<string | number> | null {
  const key = path[path.length - 1];
  if (typeof key !== "string" || !key.endsWith("_url")) return null;
  const base = key === "mobile_image_url" ? "image" : key.slice(0, -4);
  return [...path.slice(0, -1), `${base}_alt`];
}

interface UsedPhoto {
  image: RevampStoredImage;
  alt: string;
  where: string;
}

/**
 * The stored plan (version 2) from the compiled plan, the photographs the
 * runner stored and the merchant's products. Pure: the same inputs always
 * give the same plan, so a resumed run assembles the same card.
 */
export function assembleRevampPlan(
  input: RevampAssembleInput,
): RevampStoredPlan {
  const { request, snapshot, plan } = input;
  const pages = clone(plan.pages);
  // ★ Every note on the card is the code's own: the compiler's fixes here,
  //   then the ones below. The planner writes none (L2-G, site-schema.ts).
  const notes = [...(plan.notes ?? [])];
  const slots = new Map<string, RevampStoredImage>();
  const studio = new Map<string, RevampStoredImage>();
  for (const image of input.images) {
    if (image.role === "slot") slots.set(image.slotId, image);
    else if (image.role === "product") studio.set(image.slotId, image);
  }
  const shots = new Map(plan.shots.map((shot) => [shot.id, shot]));
  const opening = revampOpeningBinding(plan);
  const pageOf = new Map(pages.map((page) => [page.slug, page]));
  const sectionIn = (binding: RevampSlotBinding) =>
    pageOf
      .get(binding.pageSlug)
      ?.sections.find((s) => s.id === binding.sectionId) ?? null;

  // Resolve every photo slot to its stored image.
  const cleared = new Set<PageSectionItem>();
  const categoryPhotos = new Map<string, RevampStoredImage>();
  for (const binding of plan.bindings) {
    const image = slots.get(binding.shotId) ?? null;
    if (binding.pageSlug === CATEGORY_PAGE) {
      if (image) categoryPhotos.set(binding.sectionId, image);
      continue;
    }
    const section = sectionIn(binding);
    if (!section) continue;
    revampSetValueAt(section.config, binding.path, image?.url ?? "");
    if (binding.phonePath) {
      // ★ Never a slot reference left behind: no phone crop means the phone
      //   shows the main photograph, which the storefront does with "".
      const phone = image
        ? slots.get(`${binding.shotId}${REVAMP_PHONE_CROP_SUFFIX}`)
        : undefined;
      revampSetValueAt(section.config, binding.phonePath, phone?.url ?? "");
    }
    if (!image) cleared.add(section);
  }

  // A section whose photo could not be made goes when it cannot show without it.
  for (const page of pages) {
    page.sections = page.sections.filter((section) => {
      if (!cleared.has(section) || revampSectionRenders(section)) return true;
      notes.push(
        `The ${revampSectionLabel(section)} on the ${revampPageName(page.slug, page.title)} was left out because its new photo could not be made.`,
      );
      return false;
    });
  }

  // The photographs the pages now show, each named once.
  const used = new Map<string, UsedPhoto>();
  for (const binding of plan.bindings) {
    const image = slots.get(binding.shotId);
    if (!image || used.has(image.slotId)) continue;
    const subject = shots.get(binding.shotId)?.subject?.trim() ?? "";
    if (binding.pageSlug === CATEGORY_PAGE) {
      const name = categoryName(request, snapshot, binding.sectionId);
      if (!name) continue;
      used.set(image.slotId, {
        image,
        alt: subject || name,
        where: `${name} category`,
      });
      continue;
    }
    const page = pageOf.get(binding.pageSlug);
    const section = page?.sections.find((s) => s.id === binding.sectionId);
    if (!page || !section) continue;
    const altPath = altPathFor(binding.path);
    const sectionAlt = altPath
      ? revampValueAt(section.config, altPath)
      : undefined;
    const isOpening =
      !!opening &&
      binding.pageSlug === "" &&
      binding.sectionId === opening.sectionId &&
      binding.shotId === opening.shotId;
    used.set(image.slotId, {
      image,
      alt:
        (typeof sectionAlt === "string" && sectionAlt.trim()) ||
        subject ||
        page.title,
      where: `${revampPageName(page.slug, page.title)}, ${isOpening ? "opening photo" : revampSectionLabel(section)}`,
    });
  }
  const newPhotoUrls = new Set([...used.values()].map((u) => u.image.url));

  const storedPages: RevampStoredPage[] = pages.map((page) => {
    const before = revampSnapshotPageFor(snapshot, page);
    return {
      pageId: page.create ? null : (page.pageId ?? before?.id ?? null),
      slug: page.slug,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      create: page.create,
      expectedVersion: before?.version ?? null,
      expectedDigest: before?.sectionsDigest ?? null,
      sections: page.sections,
      proposedDigest: revampSectionsDigest(page.sections),
      changes: revampPageChanges(page.sections, before, newPhotoUrls),
    };
  });

  // ★ A product the store already has is never created again (known-1b),
  //   and the merchant is told why it is not in the list.
  const existing = revampExistingProducts({ request, snapshot });
  const alreadyHave = alreadyHaveNotes(request, existing);
  notes.push(...alreadyHave);
  // ★★ THE TAGLINE AND FOOTER DESCRIPTION NEED BRANDING MANAGE. Apply writes
  //   them to the live store and refuses the WHOLE card for a requester who
  //   cannot (apply-v2.ts), so a card made for one leaves them as they are
  //   and says why, instead of offering a button that can only fail.
  const plannedBrand = nextBrand(snapshot, plan);
  const brand = input.canChangeBrand ? plannedBrand : null;
  if (plannedBrand && !brand) notes.push(REVAMP_BRAND_PERMISSION_NOTE);
  const created = createdProducts(request, snapshot, plan, studio, existing);
  const chrome = nextChrome(snapshot.chrome.value, plan, snapshot.theme);
  // Said only when there was a line to see go (an unread one may be none).
  if (
    snapshot.theme.announcement &&
    barShowsThemeLine(
      snapshot.chrome.value?.header?.announcement,
      snapshot.theme,
    ) &&
    !chrome.header.announcement.enabled
  ) {
    notes.push(REVAMP_THEME_BAR_NOTE);
  }
  const charges = chargesFor({
    plan,
    request,
    storedPages,
    outcomes: input.outcomes,
    used,
    created,
    studio,
  });

  return {
    schemaVersion: REVAMP_SCHEMA_VERSION,
    revampId: input.revampId,
    kind: request.kind,
    summary: plan.summary,
    pages: storedPages,
    chrome: {
      expectedVersion: snapshot.chrome.version,
      expectedDigest: snapshot.chrome.digest,
      next: chrome,
    },
    brand,
    categories: storedCategories(request, snapshot, categoryPhotos),
    products: {
      hide: snapshot.products
        .filter((p) => p.sample && p.status === "published")
        .map(
          (p): PersonalizationStoredProduct => ({
            id: p.id,
            name: p.name,
            expectedUpdatedAt: p.updatedAt,
          }),
        ),
      create: created,
    },
    photos: [...used.values()].map(
      (u): PersonalizationStoredPhoto => ({
        url: u.image.url,
        path: u.image.path,
        alt: u.alt,
        where: u.where,
      }),
    ),
    checks: [],
    skipped: [
      ...(plan.skipped ?? []),
      ...fallbackPhotoLines(input.outcomes, used),
      // A product that is not created has no studio photo to miss.
      ...input.productFailures
        .filter((failure) => !existing.has(failure.key))
        .map((failure) => ({
          label: `Studio photo of ${request.products.find((p) => p.key === failure.key)?.name ?? "a product"}`,
          reason: failure.reason,
        })),
    ],
    notes,
    explanation: clipText(plan.summary ?? "", MAX_EXPLANATION),
    credits: revampCreditsFromCharges(charges),
    free: input.free,
    charges,
  };
}

/**
 * ★★ THE CARD CHARGES FOR WHAT THIS REVAMP MADE AND STILL SHOWS (money-1,
 * money-2), item by item:
 *   pages        the pages it writes (a refinement's copied pages are the
 *                parent's);
 *   photos       each photograph drawn in this revamp ("generated") that a
 *                page or category still shows. A recrop of another photo
 *                is listed under "Not done this time" and never charged; a
 *                photograph a refinement carried over is the parent's,
 *                even when the photos step had to draw it again (that is
 *                our failure, not new work);
 *   design       a look of its own, unless carried;
 *   chrome       the header and footer, unless carried;
 *   categories   the confirmed changes beyond the parent's;
 *   productPhotos a studio photo shown on a product it creates, never one
 *                of a refinement's parent's products it was not asked to
 *                change (`productPhotoRule`).
 * checks.ts recounts it after it takes photographs out.
 */
function chargesFor(input: {
  plan: RevampSitePlan;
  request: RevampRequest;
  storedPages: readonly RevampStoredPage[];
  outcomes: readonly RevampPhotoOutcome[];
  used: ReadonlyMap<string, UsedPhoto>;
  created: readonly RevampStoredProductCreate[];
  studio: ReadonlyMap<string, RevampStoredImage>;
}): RevampChargeBasis {
  const { plan, request } = input;
  const carried = plan.basis?.carried ?? null;
  const carriedPages = new Set(carried?.pages ?? []);
  const carriedShots = new Set(carried?.shots ?? []);
  const photoUrls: string[] = [];
  for (const outcome of input.outcomes) {
    if (outcome.status !== "generated" || carriedShots.has(outcome.shotId)) {
      continue;
    }
    const url = input.used.get(outcome.shotId)?.image.url;
    if (url && !photoUrls.includes(url)) photoUrls.push(url);
  }
  const rule = productPhotoRule(plan.basis, request);
  return {
    pages: input.storedPages
      .filter((page) => !carriedPages.has(page.slug))
      .map((page) => page.slug),
    photoUrls,
    design: revampDesignHasOverride(plan.design) && !carried?.design,
    chrome: !carried?.chrome,
    categories: newCategoryChanges(plan.basis, request),
    productPhotoKeys: input.created
      .filter(
        (product) =>
          input.studio.has(product.key) &&
          product.imageUrl === input.studio.get(product.key)?.url &&
          rule(product.key) === "charged",
      )
      .map((product) => product.key),
  };
}

/** "a and b": a list as a sentence reads it. */
function namesList(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The notes for request products the store already has: one sentence for
 * those on the shop, one for those still drafts (so the merchant knows why
 * they do not see it, and where to fix that).
 */
function alreadyHaveNotes(
  request: RevampRequest,
  existing: ReadonlyMap<string, { status: string }>,
): string[] {
  const live: string[] = [];
  const drafts: string[] = [];
  for (const product of request.products) {
    const match = existing.get(product.key);
    if (!match) continue;
    const name = product.name.trim().replace(/\s+/g, " ");
    if (!name) continue;
    (match.status === "published" ? live : drafts).push(name);
  }
  const notes: string[] = [];
  if (live.length === 1) {
    notes.push(
      `${live[0]} is already on your shop, so it was not added again.`,
    );
  } else if (live.length > 1) {
    notes.push(
      `${namesList(live)} are already on your shop, so they were not added again.`,
    );
  }
  if (drafts.length === 1) {
    notes.push(
      `${drafts[0]} is already in your products as a draft, so it was not added again; publish it under Products to show it.`,
    );
  } else if (drafts.length > 1) {
    notes.push(
      `${namesList(drafts)} are already in your products as drafts, so they were not added again; publish them under Products to show them.`,
    );
  }
  return notes;
}

/** A line under "Not done this time" for each photo drawn as a crop of another. */
function fallbackPhotoLines(
  outcomes: readonly RevampPhotoOutcome[],
  used: ReadonlyMap<string, UsedPhoto>,
): Array<{ label: string; reason: string }> {
  const lines: Array<{ label: string; reason: string }> = [];
  for (const outcome of outcomes) {
    if (outcome.status !== "failed") continue;
    const photo = used.get(outcome.shotId);
    if (!photo) continue;
    lines.push({
      label: photo.where,
      reason:
        outcome.reason ??
        "This new photo could not be made, so a crop of another photograph from the same shoot is used here.",
    });
  }
  return lines;
}

function categoryName(
  request: RevampRequest,
  snapshot: RevampSnapshot,
  slug: string,
): string | null {
  for (const change of request.categories) {
    if (change.action === "create") {
      const created =
        (change.slug ?? "").trim() || categorySlugFromName(change.name);
      if (created === slug) return change.name;
    } else if (change.slug === slug && change.action === "update") {
      const existing = snapshot.categories.find((c) => c.slug === slug);
      return change.name?.trim() || existing?.name || null;
    }
  }
  return null;
}

/**
 * The merchant's confirmed category changes in plan version 1's shapes, so
 * the apply path writes them exactly as a single proposal would. A category
 * photograph replaces the image only when one was stored.
 */
function storedCategories(
  request: RevampRequest,
  snapshot: RevampSnapshot,
  photos: ReadonlyMap<string, RevampStoredImage>,
): PersonalizationStoredCategory[] {
  const bySlug = new Map(snapshot.categories.map((c) => [c.slug, c]));
  const out: PersonalizationStoredCategory[] = [];
  for (const change of request.categories) {
    if (change.action === "create") {
      const slug =
        (change.slug ?? "").trim() || categorySlugFromName(change.name);
      if (!slug) continue;
      out.push({
        action: "create",
        slug,
        name: change.name,
        description: change.description,
        imageUrl: photos.get(slug)?.url ?? null,
      });
      continue;
    }
    // ★ The request was checked against this snapshot; a category gone since
    //   is the apply path's conflict to report, not one to invent here.
    const existing = bySlug.get(change.slug);
    if (!existing) continue;
    if (change.action === "hide") {
      out.push({
        action: "hide",
        id: existing.id,
        slug: existing.slug,
        expectedUpdatedAt: existing.updatedAt,
        name: existing.name,
      });
      continue;
    }
    const before = {
      name: existing.name,
      description: existing.description,
      imageUrl: existing.imageUrl,
    };
    out.push({
      action: "update",
      id: existing.id,
      slug: existing.slug,
      expectedUpdatedAt: existing.updatedAt,
      before,
      name: change.name?.trim() || existing.name,
      description: change.description ?? existing.description,
      imageUrl: photos.get(existing.slug)?.url ?? existing.imageUrl,
    });
  }
  return out;
}

/**
 * The merchant's products as Apply creates them. ★ Slugs come from
 * `revampNewProductSlugs`, in request order, so the plan's "/shop/<slug>"
 * links and the created products agree by construction. ★ A product the
 * store already has is not one of them (known-1b).
 */
function createdProducts(
  request: RevampRequest,
  snapshot: RevampSnapshot,
  plan: RevampSitePlan,
  studio: ReadonlyMap<string, RevampStoredImage>,
  existing: ReadonlyMap<string, unknown>,
): RevampStoredProductCreate[] {
  const slugs = revampNewProductSlugs({ request, snapshot });
  const toCreate = request.products.filter(
    (product) => !existing.has(product.key),
  );
  return toCreate.map((product): RevampStoredProductCreate => {
    const sizes = product.sizes;
    const first = sizes[0] ?? { label: "", price: 0, mrp: null };
    const several = sizes.length > 1;
    const copy = (plan.productCopy?.[product.key] ?? "").trim();
    return {
      key: product.key,
      name: product.name,
      slug: slugs.get(product.key) ?? "",
      description: copy || product.description,
      categorySlug: product.categorySlug,
      // ★ A studio photo that failed falls back to the merchant's own photo.
      imageUrl: studio.get(product.key)?.url ?? product.photoUrl,
      sourceImageUrl: product.photoUrl,
      options: several
        ? [{ name: "Size", values: sizes.map((size) => size.label) }]
        : [],
      variants: several
        ? sizes.map((size) => ({
            name: composeVariantName([size.label]),
            optionValues: [size.label],
            price: size.price,
            mrp: size.mrp,
          }))
        : [],
      price: first.price,
      mrp: first.mrp,
    };
  });
}

/** Why the card's chrome has the announcement bar switched off (output-2). */
export const REVAMP_THEME_BAR_NOTE =
  "Your theme's sample announcement bar was switched off; turn it on with a line of your own in Website Builder.";

/**
 * True when the bar shows the theme's own line, not the merchant's: switched
 * on with no text (the storefront then shows the pinned theme's line,
 * `withThemeAnnouncement`), or holding exactly the theme's words. ★ A theme
 * line the snapshot never read counts as one on an empty bar: switching off
 * a bar with nothing to show changes nothing a shopper sees, and a sample
 * promise left live ("delivery across Bengaluru" on a Chennai shop) is the
 * failure.
 */
function barShowsThemeLine(
  bar: { enabled?: boolean; text?: string } | undefined,
  theme: Pick<RevampSnapshot["theme"], "announcement">,
): boolean {
  if (bar?.enabled === false) return false;
  const line = theme.announcement;
  const text = (bar?.text ?? "").trim();
  if (!text) return line !== null;
  return !!line && text === line.text.trim();
}

/**
 * The whole next chrome draft: the store's chrome today with the plan's
 * menus, layout choices, design, announcement and newsletter wording, then
 * the save sanitiser. ★ An empty menu, a blank announcement or a design with
 * no override of its own means "no change", never "delete what the merchant
 * has": a budget that dropped the design keeps the store's current look.
 * ★★ EXCEPT A BAR THAT SHOWS THE THEME'S LINE (output-2): "" is the plan's
 *    "none", and leaving the bar on shows the theme's sample promise, which
 *    the checks never see (they read the bar's own empty text).
 */
function nextChrome(
  current: StoreChrome,
  plan: RevampSitePlan,
  theme: Pick<RevampSnapshot["theme"], "announcement">,
): StoreChrome {
  const next = clone(current ?? ({} as StoreChrome));
  next.header = { ...(next.header ?? {}) } as StoreChrome["header"];
  next.footer = { ...(next.footer ?? {}) } as StoreChrome["footer"];
  if (plan.menus?.header?.length) next.header.links = clone(plan.menus.header);
  if (plan.menus?.footerGroups?.length) {
    next.footer.groups = clone(plan.menus.footerGroups);
  }
  const appearance = { ...(next.appearance ?? {}) } as Json;
  for (const [key, value] of Object.entries(plan.appearance ?? {})) {
    if (value !== null && value !== undefined) appearance[key] = value;
  }
  next.appearance = appearance as unknown as StorefrontAppearance;
  if (revampDesignHasOverride(plan.design)) next.design = clone(plan.design);
  const text = plan.announcement?.text?.trim() ?? "";
  if (text) {
    next.header.announcement = {
      enabled: true,
      text,
      href: plan.announcement.href?.trim() ?? "",
    };
  } else if (barShowsThemeLine(next.header.announcement, theme)) {
    next.header.announcement = {
      enabled: false,
      text: next.header.announcement?.text ?? "",
      href: next.header.announcement?.href ?? "",
    };
  }
  const newsletter = { ...(next.footer.newsletter ?? {}) } as Json;
  for (const key of ["heading", "subtext", "buttonLabel"] as const) {
    const value = plan.newsletter?.[key]?.trim();
    if (value) newsletter[key] = value;
  }
  next.footer.newsletter =
    newsletter as unknown as StoreChrome["footer"]["newsletter"];
  return sanitizeChromeForSave(next);
}

/** The tagline and footer description; a blank one stays as it is. */
function nextBrand(
  snapshot: RevampSnapshot,
  plan: RevampSitePlan,
): RevampStoredPlan["brand"] {
  const tagline = plan.brand?.tagline?.trim() || null;
  const blurb = plan.brand?.blurb?.trim() || null;
  if (tagline === null && blurb === null) return null;
  return { expectedDigest: snapshot.brand.digest, tagline, blurb };
}
