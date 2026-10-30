import "server-only";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  products,
  storeBillingSettings,
  storePages,
  stores,
} from "@/drizzle/schema";
import { gstStateName } from "@/lib/billing/gst";
import { hasDesignOverrides, themeDesignDefaults } from "@/lib/chrome/design";
import {
  DEFAULT_CHROME,
  resolveStorefrontAppearance,
  type StoreChrome,
} from "@/lib/chrome/types";
import { withService, type Db } from "@/lib/db/client";
import {
  blockedMedia,
  isBlockedAddressIn,
  type BlockedMediaSet,
} from "@/lib/moderation/blocked-objects";
import { productGallery } from "@/lib/products/gallery";
import { validateSections } from "@/lib/sections/registry";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { gcsPathFromUrl } from "@/lib/storage/gcs";
import { isStoreOwnedObjectPath } from "@/lib/storage/paths";
import { isStoreLaunched, isThemePending } from "@/lib/store/launch-state";
import { normalizeAnnouncement } from "@/lib/themes/announcement";
import { readThemeSelection } from "@/lib/themes/meta";
import { resolveInstalledThemeDefinitionWithDb } from "@/lib/themes/runtime-registry";
import type { ThemeDefinition } from "@/lib/themes/types";
import { MinkToolInputError } from "../errors";
import { normalizeMediaUrl } from "../storefront-media-policy";
import {
  assertBuilderAccess,
  readCategories,
  readChrome,
  readFacts,
  themeSectionIdsFor,
  type PersonalizationFacts,
} from "../storefront-personalization-context";
import type { MinkActorContext } from "../types";
import {
  REVAMP_ERROR_MESSAGES,
  REVAMP_LIMITS,
  REVAMP_SKIPPED_SLUGS,
  type RevampRequest,
  type RevampSnapshot,
  type RevampSnapshotCategory,
  type RevampSnapshotPage,
  type RevampSnapshotProduct,
  type RevampThemeInfo,
} from "./contract";
import {
  revampBrandDigest,
  revampChromeDigest,
  revampSectionsDigest,
} from "./digests";
import {
  classifySectionOwners,
  collectRevampImageUrls,
  findBrokenImages,
  isReplaceablePhotoUrl,
  readMinkWrittenSectionDigests,
} from "./ownership";
import { RevampStepError, type RevampStepContext } from "./ports";

// ---------------------------------------------------------------------------
// The store as a revamp reads it, once (docs/mink-storefront-revamp.md,
// section 4.3, the `snapshot` step; build spec section 3.2).
//
// Two consumers. The runner's first step stores a `RevampSnapshot`: every
// page's Builder draft with its version, digest and the owner of each
// section, the chrome draft and its digest, the brand text, categories,
// products, the store's facts and which photos may be replaced. Every later
// step plans against it and the apply path locks against its versions and
// digests. `get_storefront_revamp_context` gives the model a short SUMMARY of
// the same reads for the interview.
//
// ★★ THE BUILDER DRAFT, NOT THE LIVE PAGE: a revamp is applied to the draft,
//    so the draft is what it is written against (v1's rule), and every
//    digest here is the one `digests.ts` gives the apply path.
// ★★ READ WITH THE REQUESTER'S AUTHORITY. The planner model reads what this
//    returns and has no actor of its own, so the snapshot is where its view
//    of the store is bounded: categories need Categories view, products
//    Products view, and the theme's sample products Products manage (the
//    only thing a revamp does with a sample is take it off the shop, which
//    needs manage; a sample it cannot see is a sample it leaves alone).
// ★ ONE TRANSACTION FOR THE DATABASE, THE NETWORK AFTER IT. Every row is read
//   on one connection; the broken-photo checks (bucket lookups, file stats)
//   run once the transaction has committed, so a slow lookup never holds a
//   pooled connection open.
// ★★ NOTHING STOREMINK BLOCKED (takedown design 3.4 and 5.7, plan A18), told
//    to the store or not. A blocked product or category is not read at all,
//    so no plan can feature it; a blocked page stays in the list, unread and
//    marked never-written (`skipped: "policy"`, which a default redesign
//    passes over in silence and the context summary leaves out), so its
//    address is never planned as a new page; a blocked picture is a broken
//    one to the runner (replaced, never reused) and never a product photo
//    the photos step reads. Nothing here names a block.
// ---------------------------------------------------------------------------

/** Pages read per store, the homepage first. */
const MAX_PAGES = 100;
/** Products read per store, the theme's samples first. */
const MAX_PRODUCTS = 1_000;
/**
 * Rows the lookup of the request's own product names may return past that
 * cap: a few per name for a store that holds one twice, the published first.
 */
const NAMED_PRODUCTS_MAX = REVAMP_LIMITS.maxProducts * 5;
/** Basket names its sample products "… (Sample)" (v1's rule). */
const SAMPLE_MARK = "(Sample)";
const SAMPLE_LIKE = `%${SAMPLE_MARK}%`;
/**
 * Seeds matched by address and name. Bundled themes seed eight to twelve;
 * the bound only keeps one statement's parameter list finite for a theme
 * package nobody has written yet.
 */
const MAX_SAMPLE_SEEDS = 200;
/** Free text the snapshot keeps about the store's place. */
const PLACE_CHARS = 80;

/** What the requester may see, and so what the snapshot reads. */
interface Visibility {
  categories: boolean;
  /** "all" includes the theme's samples; "real" leaves them out. */
  products: "none" | "real" | "all";
}

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
}

interface StoreState {
  store: StoreRow;
  launched: boolean;
  definition: ThemeDefinition;
  theme: RevampThemeInfo;
  pages: RevampSnapshotPage[];
  /** Pages StoreMink blocked: in `pages` as never-written, never summarised. */
  blockedPageIds: ReadonlySet<string>;
  chrome: RevampSnapshot["chrome"];
  brand: RevampSnapshot["brand"];
  /** Null: this requester may not see them. */
  categories: RevampSnapshotCategory[] | null;
  products: RevampSnapshotProduct[] | null;
  facts: RevampSnapshot["facts"];
  customCode: boolean;
}

type StoreRead =
  | { kind: "missing" }
  | { kind: "no_theme"; store: StoreRow; launched: boolean }
  | { kind: "ready"; state: StoreState };

// ---------------------------------------------------------------------------
// The runner's snapshot.
// ---------------------------------------------------------------------------

/**
 * Everything the revamp reads about the store, for the `snapshot` step.
 *
 * Refuses with a closed code: `not_allowed` when the requester can no longer
 * change the Website Builder, `theme_missing` when the store has no theme yet
 * (`isThemePending`) or its theme cannot be read (a revamp works within the
 * current theme, and without it nothing can be told apart from sample
 * content). A database error propagates as it is, which the runner treats as
 * a reason to try again; an abort propagates with its own reason.
 */
export async function readRevampSnapshot(
  ctx: RevampStepContext,
  request: RevampRequest,
): Promise<RevampSnapshot> {
  const { actor, signal } = ctx;
  signal.throwIfAborted();
  if (!mayRevamp(actor)) {
    throw new RevampStepError(
      "not_allowed",
      "The requester can no longer change the Website Builder.",
    );
  }
  const read = await withService((db) =>
    readStoreState(
      db,
      actor,
      snapshotVisibility(actor),
      request.products.map((product) => product.name),
    ),
  );
  signal.throwIfAborted();
  if (read.kind === "missing") {
    throw new RevampStepError("internal", "The store could not be read.");
  }
  if (read.kind === "no_theme") {
    throw new RevampStepError(
      "theme_missing",
      "The store has no theme a revamp can work within.",
    );
  }
  // The blocked set is read once the transaction has committed: it may
  // reload through a scope of its own.
  const blocked = await blockedMedia();
  const state = withoutBlockedProductPhotos(read.state, blocked);
  const photos = await readPhotos(state, request, signal, blocked);
  return {
    storeId: state.store.id,
    storeName: state.store.name,
    storeSlug: state.store.slug,
    launched: state.launched,
    theme: state.theme,
    pages: state.pages,
    chrome: state.chrome,
    brand: state.brand,
    categories: state.categories ?? [],
    products: state.products ?? [],
    facts: state.facts,
    photos,
    entitlements: { customCode: state.customCode },
  };
}

/** The runner's own gate, checked again here before anything is read. */
function mayRevamp(actor: MinkActorContext): boolean {
  return (
    actor.draftingEnabled === true &&
    can(actor.permissions, "builder", "manage", actor.isSuperadmin)
  );
}

function snapshotVisibility(actor: MinkActorContext): Visibility {
  return {
    categories: can(
      actor.permissions,
      "categories",
      "view",
      actor.isSuperadmin,
    ),
    products: can(actor.permissions, "products", "manage", actor.isSuperadmin)
      ? "all"
      : can(actor.permissions, "products", "view", actor.isSuperadmin)
        ? "real"
        : "none",
  };
}

/**
 * Which photos a revamp may replace, and which no longer load.
 *
 * ★ ONLY A PHOTO THAT WOULD OTHERWISE BE KEPT IS CHECKED. A theme file or an
 *   earlier Mink photo is replaceable whether it loads or not, so the bounded
 *   check (`findBrokenImages`, at most 80 by default) is spent on the
 *   merchant's own photos, the pages the merchant named first, then the rest
 *   of the writable pages, then menu and category pictures.
 * ★ Ordered by that same priority, never by which check finished first, so
 *   two reads of an unchanged store give the same lists.
 */
async function readPhotos(
  state: StoreState,
  request: RevampRequest,
  signal: AbortSignal,
  blocked: BlockedMediaSet,
): Promise<RevampSnapshot["photos"]> {
  const storeId = state.store.id;
  const urls = candidateImageUrls(state, request);
  const unchecked = new Set<string>();
  const merchants = urls.filter(
    (url) => !isReplaceablePhotoUrl(url, { storeId, broken: unchecked }),
  );
  // ★ A picture StoreMink blocked counts as broken without a check: shoppers
  //   see the placeholder there, so a revamp replaces it and never reuses it.
  const isBlocked = (url: string) => isBlockedAddressIn(blocked, url);
  const found = await findBrokenImages(
    merchants.filter((url) => !isBlocked(url)),
    { signal },
  );
  const broken = merchants.filter((url) => isBlocked(url) || found.has(url));
  const brokenSet = new Set(broken);
  return {
    replaceable: urls.filter((url) =>
      isReplaceablePhotoUrl(url, { storeId, broken: brokenSet }),
    ),
    broken,
    readable: readableProductPhotos(state, request).filter(
      (url) => !isBlocked(url),
    ),
  };
}

/**
 * The state with every product photo StoreMink blocked taken off its product
 * (`imageUrl: null`), so the planner is never told the product has a photo it
 * could show or send to the image model.
 */
function withoutBlockedProductPhotos(
  state: StoreState,
  blocked: BlockedMediaSet,
): StoreState {
  if (!state.products) return state;
  return {
    ...state,
    products: state.products.map((product) =>
      product.imageUrl && isBlockedAddressIn(blocked, product.imageUrl)
        ? { ...product, imageUrl: null }
        : product,
    ),
  };
}

/**
 * ★★ REAL GOODS OR NO GOODS (B16): the product photos a shot of the
 * merchant's goods can be drawn from. The photos step reads a product's photo
 * only as an object under this store's own prefix in our bucket
 * (`readStoreOwnedImageBytes`), so a photo it can never read (an outside link
 * a catalogue import kept, or an upload from before store prefixes) is left
 * off here, and the planner is never told photo=yes for it. Decided by the
 * bucket's own rule here, because the compiler is pure.
 */
function readableProductPhotos(
  state: StoreState,
  request: RevampRequest,
): string[] {
  const storeId = state.store.id;
  const out = new Set<string>();
  const offer = (raw: string | null | undefined) => {
    const url = (raw ?? "").trim();
    if (!url || out.has(url)) return;
    const path = gcsPathFromUrl(url);
    if (path && isStoreOwnedObjectPath(path, storeId)) out.add(url);
  };
  for (const product of request.products) offer(product.photoUrl);
  for (const product of state.products ?? []) {
    if (!product.sample) offer(product.imageUrl);
  }
  return [...out];
}

/** Every picture a revamp might touch, de-duplicated, most important first. */
function candidateImageUrls(
  state: StoreState,
  request: RevampRequest,
): string[] {
  const named = requestedSlugs(request);
  const writable = state.pages.filter((page) => page.skipped === null);
  const ordered = named
    ? [
        ...writable.filter((page) => named.has(page.slug)),
        ...writable.filter((page) => !named.has(page.slug)),
      ]
    : writable;
  const urls: string[] = [];
  for (const page of ordered)
    urls.push(...collectRevampImageUrls(page.sections));
  for (const link of state.chrome.value.header.links) {
    if (link.image_url) urls.push(link.image_url);
  }
  for (const category of state.categories ?? []) {
    if (category.imageUrl) urls.push(category.imageUrl);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = normalizeMediaUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * The page slugs a request names, with "home" read as the homepage; null for
 * the default scope (a refinement's own pages first, then the request's).
 */
function requestedSlugs(request: RevampRequest): Set<string> | null {
  const named = request?.refineScope?.pages ?? request?.pages ?? null;
  if (!Array.isArray(named) || !named.length) return null;
  const out = new Set<string>();
  for (const slug of named) {
    if (typeof slug !== "string") continue;
    const value = slug.trim().toLowerCase();
    out.add(value === "home" ? "" : value);
  }
  return out.size ? out : null;
}

// ---------------------------------------------------------------------------
// The reads both consumers share.
// ---------------------------------------------------------------------------

async function readStoreState(
  db: Db,
  actor: MinkActorContext,
  visibility: Visibility,
  /** The request's own product names, found whatever the cap (f-10). */
  productNames: readonly string[] = [],
): Promise<StoreRead> {
  const storeId = actor.storeId;
  const [row] = await db
    .select({
      id: stores.id,
      name: stores.name,
      slug: stores.slug,
      settings: stores.settings,
    })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  if (!row) return { kind: "missing" };
  const settings = asRecord(row.settings);
  const store: StoreRow = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    settings,
  };
  const launched = isStoreLaunched({ settings });
  // ★ Checked before anything else is read: a store still choosing its
  //   theme has only the platform's blank pages, nothing to redesign.
  if (isThemePending({ settings }))
    return { kind: "no_theme", store, launched };
  const definition = await resolveInstalledThemeDefinitionWithDb(
    db,
    readThemeSelection(settings),
  );
  if (!definition) return { kind: "no_theme", store, launched };

  const minkDigests = await readMinkWrittenSectionDigests(db, storeId);
  const { pages, blockedPageIds } = await readSnapshotPages(
    db,
    storeId,
    definition,
    minkDigests,
  );
  const chromeRead = await readChrome(db, storeId);
  const categories = visibility.categories
    ? await readCategories(db, storeId, sampleCategorySlugs(definition))
    : null;
  const productRows =
    visibility.products === "none"
      ? null
      : await readSnapshotProducts(
          db,
          storeId,
          visibility.products,
          sampleProductSeeds(definition),
          productNames,
        );
  const facts = await readFacts(db, storeId, settings, actor.effectivePlan);
  const place = await readPlace(db, storeId, settings);
  const brand = asRecord(settings.brand);

  return {
    kind: "ready",
    state: {
      store,
      launched,
      definition,
      theme: themeInfo(definition, settings),
      pages,
      blockedPageIds,
      chrome: {
        rowExists: chromeRead.rowExists,
        version: chromeRead.version,
        digest: revampChromeDigest(chromeRead.value),
        value: chromeRead.value,
      },
      brand: {
        tagline: textOrNull(brand.tagline),
        blurb: textOrNull(brand.blurb),
        digest: revampBrandDigest(settings),
      },
      categories,
      products: productRows,
      facts: { ...facts, ...place },
      customCode:
        resolveStoreSettings(settings, actor.effectivePlan)[
          "pages.customCode"
        ] === true,
    },
  };
}

/**
 * Every page's Builder draft, the homepage first.
 *
 * ★ A PAGE WHOSE DRAFT DOES NOT VALIDATE IS NEVER WRITTEN (`skipped:
 *   "invalid"`, its sections left out): writing it would mean dropping the
 *   sections that failed, which are the merchant's. The same draft-mode
 *   validation the Builder reader uses, so the digest is the one the apply
 *   path recomputes.
 * ★ A PAGE STOREMINK BLOCKED IS NEVER WRITTEN AND NEVER READ (`skipped:
 *   "policy"`, its sections left out, its SEO text too): kept in the list so
 *   its address is never planned as a new page, which the apply would refuse
 *   as taken.
 */
async function readSnapshotPages(
  db: Db,
  storeId: string,
  definition: ThemeDefinition,
  minkDigests: ReadonlySet<string>,
): Promise<{ pages: RevampSnapshotPage[]; blockedPageIds: Set<string> }> {
  const rows = await db
    .select({
      id: storePages.id,
      slug: storePages.slug,
      title: storePages.title,
      status: storePages.status,
      sections: storePages.sections,
      seoTitle: storePages.seoTitle,
      seoDescription: storePages.seoDescription,
      updatedAt: storePages.updatedAt,
      blockedAt: storePages.moderationBlockedAt,
    })
    .from(storePages)
    .where(eq(storePages.storeId, storeId))
    .orderBy(
      desc(sql`${storePages.slug} = ''`),
      asc(storePages.createdAt),
      asc(storePages.id),
    )
    .limit(MAX_PAGES);
  const blockedPageIds = new Set<string>();
  const pages = rows.map((row): RevampSnapshotPage => {
    const slug = row.slug;
    if (row.blockedAt !== null && row.blockedAt !== undefined) {
      blockedPageIds.add(row.id);
      return {
        id: row.id,
        slug,
        title: row.title.trim() || (slug === "" ? "Home" : slug),
        status: row.status,
        version: row.updatedAt,
        sectionsDigest: revampSectionsDigest([]),
        sections: [],
        owners: {},
        skipped: "policy",
        seoTitle: null,
        seoDescription: null,
      };
    }
    const validated = validateSections(row.sections, { mode: "draft" });
    const invalid = "error" in validated;
    const sections = invalid ? [] : validated.sections;
    const themeSectionIds = new Set(
      // v1's helper names the homepage "home".
      themeSectionIdsFor(definition, slug === "" ? "home" : slug, sections),
    );
    return {
      id: row.id,
      slug,
      title: row.title.trim() || (slug === "" ? "Home" : slug),
      status: row.status,
      // ★ The raw column text, full precision: the apply path compares it.
      version: row.updatedAt,
      sectionsDigest: revampSectionsDigest(sections),
      sections,
      owners: classifySectionOwners({ sections, themeSectionIds, minkDigests }),
      skipped: REVAMP_SKIPPED_SLUGS.has(slug)
        ? "policy"
        : invalid
          ? "invalid"
          : null,
      seoTitle: textOrNull(row.seoTitle),
      seoDescription: textOrNull(row.seoDescription),
    };
  });
  return {
    pages: pages.sort((a, b) => Number(b.slug === "") - Number(a.slug === "")),
    blockedPageIds,
  };
}

/**
 * The store's products, the theme's samples first (so a large catalogue
 * cannot push them past the cap), then the most recently changed.
 *
 * ★ A SAMPLE IS ONE THE THEME SEEDED AND NOBODY RENAMED: named "… (Sample)"
 *   (v1's rule, which only basket follows), OR still at the address and name
 *   a product seed of the installed theme gave it. Vitrine, studio and
 *   ritual name their samples like real goods ("Rowan Ankle Boot"), so the
 *   mark alone left their samples on the shop after a revamp. The address
 *   AND the name, never the address alone: a merchant who renamed a sample
 *   kept its address and made it theirs.
 * ★ The same rule in the query (the cap and the viewer's filter) and after
 *   it, so the two cannot disagree about which rows are samples.
 */
async function readSnapshotProducts(
  db: Db,
  storeId: string,
  mode: "real" | "all",
  seeds: ReadonlyMap<string, string>,
  names: readonly string[],
): Promise<RevampSnapshotProduct[]> {
  const seeded = seeds.size
    ? sql.join(
        [...seeds].map(([slug, name]) => sql`(${slug}, ${name})`),
        sql`, `,
      )
    : null;
  const isSample = seeded
    ? sql`(${products.name} like ${SAMPLE_LIKE} or (${products.slug}, ${products.name}) in (${seeded}))`
    : sql`${products.name} like ${SAMPLE_LIKE}`;
  const notSample = [
    sql`${products.name} not like ${SAMPLE_LIKE}`,
    seeded
      ? sql`(${products.slug}, ${products.name}) not in (${seeded})`
      : undefined,
  ];
  // ★ A product StoreMink blocked is never read (told or not), so no plan
  //   can feature it, link it or take it off the shop.
  const notBlocked = isNull(products.moderationBlockedAt);
  const rows = await db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(
      mode === "all"
        ? and(eq(products.storeId, storeId), notBlocked)
        : and(eq(products.storeId, storeId), notBlocked, ...notSample),
    )
    .orderBy(desc(isSample), desc(products.updatedAt), asc(products.id))
    .limit(MAX_PRODUCTS);
  const read = rows
    .map((row) => toSnapshotProduct(row, seeds))
    .filter((product) => mode === "all" || !product.sample);

  // ★★ THE MERCHANT'S OWN PRODUCTS BY NAME, WHATEVER THE CAP (f-10). The
  //   compiler finds a request product the store already has by its name in
  //   this list (revampExistingProducts), and the read above keeps only the
  //   most recently changed real products, so on a large catalogue an older
  //   product of the same name was missed and created again beside the
  //   first. One more store-scoped, bounded query reads every product whose
  //   name the request names, by the compiler's own name rule, the published
  //   first, never a theme sample.
  const keys = [...new Set(names.map(productNameKey).filter(Boolean))].slice(
    0,
    REVAMP_LIMITS.maxProducts,
  );
  if (keys.length === 0) return read;
  const named = await db
    .select(PRODUCT_COLUMNS)
    .from(products)
    .where(
      and(
        eq(products.storeId, storeId),
        sql`lower(btrim(regexp_replace(normalize(${products.name}, NFKC), '[[:space:]]+', ' ', 'g'))) = any(${sql.param(keys)}::text[])`,
        notBlocked,
        ...notSample,
      ),
    )
    .orderBy(
      desc(sql`${products.status} = 'published'`),
      desc(products.updatedAt),
      asc(products.id),
    )
    .limit(NAMED_PRODUCTS_MAX);
  const have = new Set(read.map((product) => product.id));
  for (const row of named) {
    const product = toSnapshotProduct(row, seeds);
    // The compiler never takes a sample, however it is spelled.
    if (product.sample || /\(sample\)\s*$/i.test(product.name)) continue;
    if (have.has(product.id)) continue;
    have.add(product.id);
    read.push(product);
  }
  return read;
}

const PRODUCT_COLUMNS = {
  id: products.id,
  name: products.name,
  slug: products.slug,
  status: products.status,
  updatedAt: products.updatedAt,
  imageUrl: products.imageUrl,
  images: products.images,
  categoryId: products.categoryId,
  // ★ What a featured_products band set to "featured" shows: the compiler
  //   names the products instead when none of the store's own is featured
  //   (output-5).
  featured: products.featured,
};

function toSnapshotProduct(
  row: {
    id: string;
    name: string;
    slug: string;
    status: string;
    updatedAt: string;
    imageUrl: string | null;
    images: string[] | null;
    categoryId: string | null;
    featured: boolean | null;
  },
  seeds: ReadonlyMap<string, string>,
): RevampSnapshotProduct {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    updatedAt: row.updatedAt,
    sample: row.name.includes(SAMPLE_MARK) || seeds.get(row.slug) === row.name,
    // The card's own first photograph (the column defaults to `['']`).
    imageUrl: productGallery(row.imageUrl, row.images)[0] ?? null,
    categoryId: row.categoryId,
    featured: row.featured === true,
  };
}

/**
 * A product name as the compiler compares it (site-compiler.ts
 * `productNameKey`, which it does not export): the Unicode compatibility
 * form, spaces collapsed, ends trimmed, case aside. ★ The named lookup's SQL
 * applies the same steps to the stored name, so a product the compiler would
 * match is one the lookup finds.
 */
function productNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The installed theme's product seeds, address to name. The definition is
 * the one the store renders (the pinned release, else the bundled one), so
 * its seeds are exactly what the theme wrote into this store.
 */
function sampleProductSeeds(definition: ThemeDefinition): Map<string, string> {
  const seeds = new Map<string, string>();
  for (const seed of definition.preset.sampleData?.products ?? []) {
    if (seeds.size >= MAX_SAMPLE_SEEDS) break;
    if (typeof seed.slug === "string" && typeof seed.name === "string") {
      seeds.set(seed.slug, seed.name);
    }
  }
  return seeds;
}

/**
 * The store's city and state, as the merchant saved them.
 *
 * ★ The city only from `settings.business` (signup's address step); the state
 *   from there too, else the GST state code on Taxes & invoices. The free-text
 *   invoice address is not parsed: a guessed city in shop copy is a claim the
 *   merchant did not make.
 */
async function readPlace(
  db: Db,
  storeId: string,
  settings: Record<string, unknown>,
): Promise<{ city: string | null; state: string | null }> {
  const business = asRecord(settings.business);
  const city = boundedText(business.city, PLACE_CHARS);
  const state = boundedText(business.state, PLACE_CHARS);
  if (state) return { city, state };
  const [billing] = await db
    .select({ stateCode: storeBillingSettings.businessStateCode })
    .from(storeBillingSettings)
    .where(eq(storeBillingSettings.storeId, storeId))
    .limit(1);
  return { city, state: stateFromCode(billing?.stateCode) };
}

function stateFromCode(code: unknown): string | null {
  const name = gstStateName(code);
  // An unknown code comes back as the bare number, which is not a place.
  return name && !/^\d+$/.test(name) ? name : null;
}

function sampleCategorySlugs(definition: ThemeDefinition): Set<string> {
  return new Set(
    definition.preset.sampleData?.categories.map((row) => row.slug) ?? [],
  );
}

/**
 * The theme's own colours and layout choices.
 *
 * ★ THE ACCENT IS THE ONE THE STOREFRONT SHOWS: the theme's fixed accent
 *   when it has one, otherwise the store's brand colour (which drives the
 *   accent on the live shop), otherwise the colour the theme seeded.
 */
function themeInfo(
  definition: ThemeDefinition,
  settings: Record<string, unknown>,
): RevampThemeInfo {
  const design = definition.preset.design;
  const palette = themeDesignDefaults(design).palette;
  const brandColour =
    hexColour(asRecord(settings.brand).primaryColor) ??
    hexColour(definition.preset.brand?.primaryColor);
  const page = palette.cream ?? "#ffffff";
  const ink = palette.ink ?? "#111111";
  const layout = resolveStorefrontAppearance(
    design.layout,
    DEFAULT_CHROME.appearance,
    definition.preset.templates,
  );
  // ★ The line the storefront shows on a bar left on with no text
  //   (withThemeAnnouncement), read with the storefront's own rule: a revamp
  //   that writes no line must switch that bar off, or the theme's sample
  //   promise stays live (output-2).
  const announcement = normalizeAnnouncement(definition.preset.announcement);
  return {
    id: definition.id,
    version: definition.release?.version ?? null,
    name: definition.name,
    palette: {
      page,
      surface: palette.surface ?? page,
      ink,
      accent: palette.accent ?? brandColour ?? ink,
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
  };
}

// ---------------------------------------------------------------------------
// The model's summary for the interview.
// ---------------------------------------------------------------------------

/** The summary, JSON-serialised, stays under this many characters. */
export const REVAMP_CONTEXT_MAX_CHARS = 6_000;

export interface RevampContextPage {
  /** "home" for the homepage, else the page's address. */
  slug: string;
  title: string;
  live: boolean;
  /** Sections the merchant wrote: kept as they are, possibly moved. */
  keptSections: number;
  /** Sections still as the theme or an earlier Mink change made them: rebuilt. */
  rebuiltSections: number;
  /** Theme photos and earlier Mink photos on the page: replaced. */
  photosToReplace: number;
}

export interface RevampContextCategory {
  slug: string;
  name: string;
  visible: boolean;
  /** Came with the theme and nobody has changed it. */
  fromTheme: boolean;
  products: number;
  hasPhoto: boolean;
}

/**
 * What `get_storefront_revamp_context` gives the model. Never a credit figure;
 * merchant text in it is the store's data, not instructions.
 */
export interface RevampContextSummary {
  store: { name: string; live: boolean; theme: string | null };
  /** Why a redesign cannot start now, in plain words; null when it can. */
  blocker: string | null;
  pages: RevampContextPage[];
  /** Pages left out of `pages` to keep the summary short. */
  morePages: number;
  /** Pages a redesign never writes, and why. */
  neverChanged: Array<{ slug: string; reason: string }>;
  brand: {
    tagline: string | null;
    taglineFromTheme: boolean;
    blurb: string | null;
    blurbFromTheme: boolean;
  } | null;
  header: { links: string[]; announcement: string | null } | null;
  footer: { groups: string[]; newsletter: string | null } | null;
  look: {
    theme: string;
    colours: RevampThemeInfo["palette"];
    header: string | null;
    card: string | null;
    footer: string | null;
    /** The merchant already set their own colours, fonts or corners. */
    ownDesign: boolean;
  } | null;
  /** Null: this role cannot see categories. */
  categories: RevampContextCategory[] | null;
  moreCategories: number;
  /** Null: this role cannot see products. */
  products: {
    yours: { live: number; drafts: number; names: string[] };
    samples: { live: number; drafts: number; takenOff: boolean };
  } | null;
  storeFacts:
    | (PersonalizationFacts & { city: string | null; state: string | null })
    | null;
  limits: {
    products: number;
    sizesPerProduct: number;
    pages: number;
    categoryChanges: number;
  };
}

/** How much of each list fits; the first level that fits is used. */
const SUMMARY_LEVELS = [
  {
    pages: 12,
    categories: 15,
    names: 8,
    links: 8,
    groups: 6,
    never: 8,
    text: 160,
    title: 60,
  },
  {
    pages: 8,
    categories: 8,
    names: 5,
    links: 6,
    groups: 4,
    never: 5,
    text: 100,
    title: 48,
  },
  {
    pages: 5,
    categories: 4,
    names: 3,
    links: 4,
    groups: 3,
    never: 4,
    text: 60,
    title: 40,
  },
  {
    pages: 3,
    categories: 0,
    names: 0,
    links: 0,
    groups: 0,
    never: 2,
    text: 40,
    title: 30,
  },
] as const;
type SummaryLevel = (typeof SUMMARY_LEVELS)[number];

const NEVER_CHANGED_REASON: Record<"policy" | "invalid", string> = {
  policy: "A store policy: change it under Settings, Policies.",
  invalid:
    "Its Website Builder draft has a problem: fix it in Website Builder first.",
};

/**
 * The store as the interview needs it: what a redesign would rebuild and keep
 * on each page, the header, footer and look, categories, products and the
 * store's facts, so Mink asks only for what it cannot read.
 *
 * ★ Website Builder view is required (a `MinkToolInputError` otherwise);
 *   categories need Categories view and products Products view, else null.
 * ★ A STORE THAT CANNOT BE REDESIGNED IS AN ANSWER, NOT AN ERROR: no theme
 *   yet, or a role that cannot change the Builder, comes back as `blocker`,
 *   so the model can say so instead of starting a job that fails.
 * ★ No network: photos are counted, never fetched, so the read stays fast and
 *   repeatable. Under `REVAMP_CONTEXT_MAX_CHARS` however large the store.
 */
export async function readRevampContextForActor(
  actor: MinkActorContext,
): Promise<RevampContextSummary> {
  assertBuilderAccess(actor, "view");
  const visibility: Visibility = {
    categories: can(
      actor.permissions,
      "categories",
      "view",
      actor.isSuperadmin,
    ),
    products: can(actor.permissions, "products", "view", actor.isSuperadmin)
      ? "all"
      : "none",
  };
  const read = await withService((db) => readStoreState(db, actor, visibility));
  if (read.kind === "missing") {
    throw new MinkToolInputError("This store is not available.");
  }
  if (read.kind === "no_theme") {
    return {
      store: {
        name: read.store.name.slice(0, 80),
        live: read.launched,
        theme: null,
      },
      blocker: REVAMP_ERROR_MESSAGES.theme_missing,
      pages: [],
      morePages: 0,
      neverChanged: [],
      brand: null,
      header: null,
      footer: null,
      look: null,
      categories: null,
      moreCategories: 0,
      products: null,
      storeFacts: null,
      limits: summaryLimits(),
    };
  }
  const { state } = read;
  const canTakeOffSamples = can(
    actor.permissions,
    "products",
    "manage",
    actor.isSuperadmin,
  );
  let summary = buildSummary(
    state,
    actor,
    canTakeOffSamples,
    SUMMARY_LEVELS[0],
  );
  for (const level of SUMMARY_LEVELS.slice(1)) {
    if (JSON.stringify(summary).length < REVAMP_CONTEXT_MAX_CHARS) break;
    summary = buildSummary(state, actor, canTakeOffSamples, level);
  }
  return summary;
}

function buildSummary(
  state: StoreState,
  actor: MinkActorContext,
  canTakeOffSamples: boolean,
  level: SummaryLevel,
): RevampContextSummary {
  const storeId = state.store.id;
  const noneBroken = new Set<string>();
  const writable = state.pages.filter((page) => page.skipped === null);
  // A page StoreMink blocked is left out of the summary altogether.
  const skipped = state.pages.filter(
    (page) => page.skipped !== null && !state.blockedPageIds.has(page.id),
  );
  const pages = writable.slice(0, level.pages).map((page) => {
    const owners = Object.values(page.owners);
    const photos = new Set(
      collectRevampImageUrls(page.sections).filter((url) =>
        isReplaceablePhotoUrl(url, { storeId, broken: noneBroken }),
      ),
    );
    return {
      slug: page.slug === "" ? "home" : page.slug,
      title: cut(page.title, level.title),
      live: page.status === "published",
      keptSections: owners.filter((owner) => owner === "merchant").length,
      rebuiltSections: owners.filter((owner) => owner !== "merchant").length,
      photosToReplace: photos.size,
    };
  });

  const preset = state.definition.preset;
  const chrome: StoreChrome = state.chrome.value;
  const announcement = chrome.header.announcement;
  const newsletter = chrome.footer.newsletter;
  const categories = state.categories;
  const productList = state.products;
  const yours = productList?.filter((product) => !product.sample) ?? [];
  const samples = productList?.filter((product) => product.sample) ?? [];
  const liveFirst = [
    ...yours.filter((product) => product.status === "published"),
    ...yours.filter((product) => product.status !== "published"),
  ];

  return {
    store: {
      name: cut(state.store.name, 80),
      live: state.launched,
      theme: state.definition.name,
    },
    blocker: permissionBlocker(actor),
    pages,
    morePages: writable.length - pages.length,
    neverChanged: skipped.slice(0, level.never).map((page) => ({
      slug: page.slug === "" ? "home" : page.slug,
      reason: NEVER_CHANGED_REASON[page.skipped ?? "invalid"],
    })),
    brand: {
      tagline: cutOrNull(state.brand.tagline, level.text),
      taglineFromTheme: sameText(state.brand.tagline, preset.brand?.tagline),
      blurb: cutOrNull(state.brand.blurb, level.text),
      blurbFromTheme: sameText(state.brand.blurb, preset.brand?.blurb),
    },
    header: {
      links: chrome.header.links
        .slice(0, level.links)
        .map((link) => cut(link.label, 30)),
      announcement: announcement.enabled
        ? cutOrNull(
            announcement.text.trim() || preset.announcement?.text || null,
            level.text,
          )
        : null,
    },
    footer: {
      groups: chrome.footer.groups
        .slice(0, level.groups)
        .map((group) => cut(group.title, 30)),
      newsletter: newsletter.enabled
        ? cutOrNull(newsletter.heading, level.text)
        : null,
    },
    look: {
      theme: state.definition.name,
      colours: state.theme.palette,
      header: state.theme.layout.header ?? null,
      card: state.theme.layout.card ?? null,
      footer: state.theme.layout.footer ?? null,
      ownDesign: chrome.design ? hasDesignOverrides(chrome.design) : false,
    },
    categories: categories
      ? categories.slice(0, level.categories).map((category) => ({
          slug: category.slug,
          name: cut(category.name, 40),
          visible: category.status === "active",
          fromTheme: category.sample,
          products: category.productCount,
          hasPhoto: Boolean(category.imageUrl),
        }))
      : null,
    moreCategories: categories
      ? Math.max(0, categories.length - level.categories)
      : 0,
    products: productList
      ? {
          yours: {
            live: yours.filter((product) => product.status === "published")
              .length,
            drafts: yours.filter((product) => product.status !== "published")
              .length,
            names: liveFirst
              .slice(0, level.names)
              .map((product) => cut(product.name, 50)),
          },
          samples: {
            live: samples.filter((product) => product.status === "published")
              .length,
            drafts: samples.filter((product) => product.status !== "published")
              .length,
            takenOff: canTakeOffSamples,
          },
        }
      : null,
    storeFacts: {
      ...state.facts,
      city: cutOrNull(state.facts.city, level.title),
      state: cutOrNull(state.facts.state, level.title),
    },
    limits: summaryLimits(),
  };
}

/** Why this requester cannot start a redesign, or null when they can. */
function permissionBlocker(actor: MinkActorContext): string | null {
  if (actor.draftingEnabled !== true) {
    return "Mink AI drafting is not switched on for this store, so a redesign cannot start.";
  }
  if (!can(actor.permissions, "builder", "manage", actor.isSuperadmin)) {
    return "Your role can look at the storefront but cannot change the Website Builder, so a redesign cannot start. Ask the store owner.";
  }
  return null;
}

function summaryLimits(): RevampContextSummary["limits"] {
  return {
    products: REVAMP_LIMITS.maxProducts,
    sizesPerProduct: REVAMP_LIMITS.maxSizes,
    pages: REVAMP_LIMITS.maxPages,
    categoryChanges: REVAMP_LIMITS.maxCategoryChanges,
  };
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** Trimmed text, or null when blank or not text (v1's `textOrNull`). */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedText(value: unknown, max: number): string | null {
  const text = textOrNull(value);
  return text ? text.slice(0, max).trim() : null;
}

function cut(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function cutOrNull(
  value: string | null | undefined,
  max: number,
): string | null {
  const text = textOrNull(value);
  return text ? cut(text, max) : null;
}

function sameText(a: string | null, b: string | undefined): boolean {
  const left = textOrNull(a);
  return left !== null && left === textOrNull(b);
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A colour as #rrggbb, or null when it is not a hex colour. */
function hexColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (!HEX_RE.test(s)) return null;
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
