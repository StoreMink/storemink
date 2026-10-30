import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  categories,
  products,
  storeChrome,
  storePages,
  storeShippingSettings,
  stores,
} from "@/drizzle/schema";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import {
  normalizeChrome,
  sanitizeChromeForSave,
  type StoreChrome,
} from "@/lib/chrome/types";
import { withService, type Db } from "@/lib/db/client";
import {
  normalizePickupPayment,
  paymentOptionsFor,
} from "@/lib/fulfilment/payment-policy";
import { resolveStoreSettings } from "@/lib/settings/registry";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { prepareSections } from "@/lib/themes/apply";
import { FONT_PAIRINGS } from "@/lib/themes/fonts";
import { readThemeSelection } from "@/lib/themes/meta";
import { resolveInstalledThemeDefinitionWithDb } from "@/lib/themes/runtime-registry";
import {
  homepageEditedSinceSeed,
  SEED_WINDOW_MS,
} from "@/lib/themes/switch-rules";
import type { ThemeDefinition, ThemeDesign } from "@/lib/themes/types";
import { getMinkConfig } from "./config";
import { imageCreditHeadroom, type ImageCreditHeadroom } from "./image-credits";
import { MinkToolInputError } from "./errors";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
import {
  describeMinkStorefrontDesign,
  digestMinkStorefrontDesign,
} from "./storefront-design-contract";
import { digestMinkStorefrontSections } from "./storefront-layout-contract";
import {
  MINK_PERSONALIZATION_MAX_PAGES,
  MINK_PERSONALIZATION_SKIPPED_SLUGS,
  buildPageInventory,
  newRefCounter,
  planPersonalizationBudget,
} from "./storefront-personalization-contract";
import type { MinkActorContext } from "./types";

// ---------------------------------------------------------------------------
// What a personalisation reads: the pages and their theme text, the header
// and footer copy, the look, the categories, the theme's sample products and
// the store's own facts.
//
// Two consumers. `get_storefront_personalization_context` gives the model a
// SUMMARY for the interview (which pages exist, how many theme photos, which
// categories came with the theme). The proposal reads the same TARGET and
// keeps its versions and digests, which the approval later re-checks.
//
// ★ IT READS THE BUILDER DRAFT, NOT THE LIVE PAGE. The proposal is applied
//   to the draft, so the draft is what it must be written against, exactly
//   as a layout proposal is.
// ---------------------------------------------------------------------------

/** Store facts the copywriter may state. Anything else it may not. */
export interface PersonalizationFacts {
  delivery: string | null;
  freeDeliveryAbove: number | null;
  returns: string | null;
  pickup: boolean;
  onlinePayments: boolean;
  cashOnDelivery: boolean;
}

export interface PersonalizationTargetPage {
  id: string;
  /** "home" for the homepage, else the stored slug. */
  slug: string;
  title: string;
  status: string;
  updatedAt: string;
  sections: PageSectionItem[];
  sectionsDigest: string;
  /** Saved by someone since the theme wrote it. */
  edited: boolean;
  /**
   * Sections still exactly as the installed theme made them: the only ones
   * whose words a personalisation rewrites or switches off.
   */
  themeSectionIds: string[];
  /** Why this page is never personalised, or null. */
  skipped: "policy" | "invalid" | null;
}

export interface PersonalizationTargetCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  status: string;
  updatedAt: string;
  sample: boolean;
  productCount: number;
}

export interface PersonalizationTargetProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
  updatedAt: string;
}

export interface PersonalizationTarget {
  storeId: string;
  storeName: string;
  themeName: string | null;
  themeDesign: ThemeDesign | null;
  pages: PersonalizationTargetPage[];
  chrome: {
    rowExists: boolean;
    version: string | null;
    value: StoreChrome;
    designDigest: string;
    /** The announcement and newsletter copy, what a text change replaces. */
    textDigest: string;
  };
  brand: { tagline: string | null; blurb: string | null; digest: string };
  categories: PersonalizationTargetCategory[] | null;
  sampleProducts: PersonalizationTargetProduct[] | null;
  facts: PersonalizationFacts;
  headroom: ImageCreditHeadroom;
  photos: { allowed: boolean; reason: string | null };
}

const MAX_CATEGORIES = 60;
const MAX_SAMPLE_PRODUCTS = 40;
const SAMPLE_MARK = "%(Sample)%";

export async function readPersonalizationTarget(
  actor: MinkActorContext,
): Promise<PersonalizationTarget> {
  assertBuilderAccess(actor, "view");
  const headroom = await imageCreditHeadroom(
    actor,
    getMinkConfig().chargeCredits,
  );
  const photoGate = await photoAvailability(actor);
  return withService(async (db) => {
    const storeRows = await db
      .select({ name: stores.name, settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, actor.storeId))
      .limit(1);
    const store = storeRows[0];
    if (!store) throw new MinkToolInputError("This store is not available.");
    const settings = asRecord(store.settings);
    const definition = await resolveInstalledThemeDefinitionWithDb(
      db,
      readThemeSelection(settings),
    ).catch(() => null);
    const sampleCategorySlugs = new Set(
      definition?.preset.sampleData?.categories.map((row) => row.slug) ?? [],
    );

    const [pages, chrome, categoryRows, sampleRows, facts] = await Promise.all([
      readPages(db, actor.storeId, settings, definition),
      readChrome(db, actor.storeId),
      can(actor.permissions, "categories", "view", actor.isSuperadmin)
        ? readCategories(db, actor.storeId, sampleCategorySlugs)
        : Promise.resolve(null),
      can(actor.permissions, "products", "view", actor.isSuperadmin)
        ? readSampleProducts(db, actor.storeId)
        : Promise.resolve(null),
      readFacts(db, actor.storeId, settings, actor.effectivePlan),
    ]);
    const brand = asRecord(settings.brand);
    const brandValues = {
      tagline: textOrNull(brand.tagline),
      blurb: textOrNull(brand.blurb),
    };
    return {
      storeId: actor.storeId,
      storeName: store.name,
      themeName: definition?.name ?? null,
      themeDesign: definition?.preset.design ?? null,
      pages,
      chrome,
      brand: { ...brandValues, digest: digestMinkStorefrontValue(brandValues) },
      categories: categoryRows,
      sampleProducts: sampleRows,
      facts,
      headroom,
      photos: photoGate,
    };
  });
}

export async function readPages(
  db: Db,
  storeId: string,
  settings: Record<string, unknown>,
  definition: ThemeDefinition | null,
): Promise<PersonalizationTargetPage[]> {
  const rows = await db
    .select({
      id: storePages.id,
      slug: storePages.slug,
      title: storePages.title,
      status: storePages.status,
      sections: storePages.sections,
      createdAt: storePages.createdAt,
      updatedAt: storePages.updatedAt,
    })
    .from(storePages)
    // ★ A page StoreMink blocked is left out, told or not (takedown design
    //   5.7): never offered, never written, never named.
    .where(
      and(
        eq(storePages.storeId, storeId),
        isNull(storePages.moderationBlockedAt),
      ),
    )
    .orderBy(asc(storePages.createdAt))
    .limit(60);
  const pages = rows.map((row): PersonalizationTargetPage => {
    const slug = row.slug === "" ? "home" : row.slug;
    const validated = validateSections(row.sections, { mode: "draft" });
    const sections = "error" in validated ? [] : validated.sections;
    const edited =
      slug === "home"
        ? homepageEditedSinceSeed(settings, {
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
        : Math.abs(Date.parse(row.updatedAt) - Date.parse(row.createdAt)) >
          SEED_WINDOW_MS;
    return {
      id: row.id,
      slug,
      title: row.title || (slug === "home" ? "Home" : slug),
      status: row.status,
      updatedAt: row.updatedAt,
      sections,
      sectionsDigest: digestMinkStorefrontSections(sections),
      edited,
      themeSectionIds: themeSectionIdsFor(definition, slug, sections),
      skipped: MINK_PERSONALIZATION_SKIPPED_SLUGS.has(slug)
        ? "policy"
        : "error" in validated
          ? "invalid"
          : null,
    };
  });
  // The homepage leads: it is the first page anyone sees and the first one
  // the budget buys.
  return pages.sort(
    (a, b) => Number(b.slug === "home") - Number(a.slug === "home"),
  );
}

/**
 * The ids of a page's sections that are still exactly as the installed theme
 * made them.
 *
 * ★ BY CONTENT, NOT BY ID: an install gives every section a fresh id
 *   (`prepareSections`), so a section is the theme's when its type and
 *   settings equal one in the theme's own copy of that page. The theme's copy
 *   is round-tripped through JSON and the same draft validation the stored
 *   page went through, so the two are compared in one form.
 * ★ NOTHING IS THE THEME'S WHEN THE THEME CANNOT BE READ, and a section from
 *   a theme the store has since switched away from is the merchant's: a
 *   section that cannot be proven to be sample content keeps its words.
 */
export function themeSectionIdsFor(
  definition: ThemeDefinition | null,
  slug: string,
  sections: readonly PageSectionItem[],
): string[] {
  if (!definition || !sections.length) return [];
  const prepared = prepareSections(definition, slug === "home" ? "" : slug);
  if ("error" in prepared) return [];
  const normalized = validateSections(
    JSON.parse(JSON.stringify(prepared.sections)),
    { mode: "draft" },
  );
  if ("error" in normalized) return [];
  const theme = new Set(normalized.sections.map(sectionContentDigest));
  return sections
    .filter((section) => theme.has(sectionContentDigest(section)))
    .map((section) => section.id);
}

export function sectionContentDigest(section: PageSectionItem): string {
  return digestMinkStorefrontValue({
    type: section.type,
    config: section.config,
  });
}

export async function readChrome(
  db: Db,
  storeId: string,
): Promise<PersonalizationTarget["chrome"]> {
  const rows = await db
    .select({ draft: storeChrome.draft, updatedAt: storeChrome.updatedAt })
    .from(storeChrome)
    .where(eq(storeChrome.storeId, storeId))
    .limit(1);
  const row = rows[0];
  const value = row
    ? sanitizeChromeForSave(row.draft)
    : await readMenusAsChrome(db, storeId);
  const design = value.design ?? EMPTY_DESIGN_OVERRIDES;
  return {
    rowExists: Boolean(row),
    version: row?.updatedAt ?? null,
    value,
    designDigest: digestMinkStorefrontDesign(design),
    textDigest: chromeTextDigest(value),
  };
}

/**
 * The header and footer a store with no `store_chrome` row really shows: its
 * old `store_menus` links (lib/chrome/queries.ts), with every other setting
 * at its default.
 *
 * ★★ THE FIRST DRAFT STARTS FROM THESE, NEVER FROM DEFAULT_CHROME. A theme
 *   install seeds `store_menus`, not `store_chrome`, so for most new stores
 *   this is the navigation; a draft built from the defaults would replace the
 *   theme's menu with StoreMink's stock links the moment the merchant
 *   published it (the Builder's own `builder-actions.ts` rule).
 *   `forUpdate` locks the row for an approval that is about to write.
 */
export async function readMenusAsChrome(
  db: Db,
  storeId: string,
  options: { forUpdate?: boolean } = {},
): Promise<StoreChrome> {
  const rows = await db.execute(sql`
    select header, footer_groups, footer_legal
    from public.store_menus
    where store_id = ${storeId}::uuid
    ${sql.raw(options.forUpdate ? "for update" : "")}
  `);
  const legacy = rows.rows[0] as
    | { header: unknown; footer_groups: unknown; footer_legal: unknown }
    | undefined;
  return sanitizeChromeForSave(
    normalizeChrome(
      legacy
        ? {
            header: { links: legacy.header },
            footer: {
              groups: legacy.footer_groups,
              legal: legacy.footer_legal,
            },
          }
        : null,
    ),
  );
}

/** The chrome copy a personalisation may replace, as one digest. */
export function chromeTextDigest(chrome: StoreChrome): string {
  return digestMinkStorefrontValue({
    announcement: chrome.header.announcement,
    newsletter: {
      enabled: chrome.footer.newsletter.enabled,
      heading: chrome.footer.newsletter.heading,
      subtext: chrome.footer.newsletter.subtext,
      buttonLabel: chrome.footer.newsletter.buttonLabel,
    },
  });
}

export async function readCategories(
  db: Db,
  storeId: string,
  sampleSlugs: ReadonlySet<string>,
): Promise<PersonalizationTargetCategory[]> {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
      imageUrl: categories.imageUrl,
      status: categories.status,
      createdAt: categories.createdAt,
      updatedAt: categories.updatedAt,
      productCount: sql<number>`(
        select count(*)::int from ${products}
        where ${products.storeId} = ${storeId}
          and ${products.categoryId} = ${categories.id}
          and ${products.moderationBlockedAt} is null
      )`,
    })
    .from(categories)
    // ★ A collection StoreMink blocked is left out, told or not, here and in
    //   the redesign snapshot that shares this read.
    .where(
      and(
        eq(categories.storeId, storeId),
        isNull(categories.moderationBlockedAt),
      ),
    )
    .orderBy(asc(categories.sortOrder), asc(categories.name))
    .limit(MAX_CATEGORIES);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    imageUrl: row.imageUrl,
    status: row.status,
    updatedAt: row.updatedAt,
    // ★ A SAMPLE IS ONE NOBODY HAS TOUCHED: the theme's slug, unchanged
    //   since it was seeded (the theme switch's own rule).
    sample:
      sampleSlugs.has(row.slug) &&
      Math.abs(Date.parse(row.updatedAt) - Date.parse(row.createdAt)) <=
        SEED_WINDOW_MS,
    productCount: Number(row.productCount) || 0,
  }));
}

async function readSampleProducts(
  db: Db,
  storeId: string,
): Promise<PersonalizationTargetProduct[]> {
  // ★ EVERY BUNDLED THEME NAMES ITS SAMPLES "… (Sample)", and nobody names
  //   their own product that. The card lists them by name, so the merchant
  //   sees exactly what will be taken off the shop before approving.
  return db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      status: products.status,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(
      and(
        eq(products.storeId, storeId),
        sql`${products.name} like ${SAMPLE_MARK}`,
        isNull(products.moderationBlockedAt),
      ),
    )
    .orderBy(asc(products.name))
    .limit(MAX_SAMPLE_PRODUCTS);
}

export async function readFacts(
  db: Db,
  storeId: string,
  settings: Record<string, unknown>,
  plan: MinkActorContext["effectivePlan"],
): Promise<PersonalizationFacts> {
  const [shipping] = await db
    .select({
      mode: storeShippingSettings.mode,
      freeAbove: storeShippingSettings.freeAbove,
      minDays: storeShippingSettings.manualMinDays,
      maxDays: storeShippingSettings.manualMaxDays,
    })
    .from(storeShippingSettings)
    .where(eq(storeShippingSettings.storeId, storeId))
    .limit(1);
  const resolved = resolveStoreSettings(settings, plan);
  const payments = await db.execute(sql`
    select exists (
      select 1 from store_payment_providers
      where store_id = ${storeId}::uuid and enabled = true
    ) as online
  `);
  const online = Boolean(
    (payments.rows[0] as { online?: boolean } | undefined)?.online,
  );
  let delivery: string | null = null;
  if (shipping?.mode === "free") {
    delivery = "Free delivery on every order";
  } else if (shipping && shipping.mode !== "shiprocket") {
    delivery = `Delivery in ${shipping.minDays} to ${shipping.maxDays} days`;
  } else if (shipping?.mode === "shiprocket") {
    delivery = "Delivery by courier, with the time shown at checkout";
  }
  const returnsOn = resolved["returns.enabled"] === true;
  const windowDays = Number(resolved["returns.windowDays"]);
  return {
    delivery,
    freeDeliveryAbove:
      shipping && shipping.mode !== "free" && Number(shipping.freeAbove) > 0
        ? Number(shipping.freeAbove)
        : null,
    returns: returnsOn
      ? Number.isFinite(windowDays) && windowDays > 0
        ? `Returns accepted within ${windowDays} days`
        : "Returns accepted"
      : null,
    pickup: resolved["fulfilment.offerPickup"] === true,
    onlinePayments: online,
    // ★ CHECKOUT'S OWN RULE (lib/fulfilment/payment-policy.ts), asked for a
    //   delivery: the writer may state cash on delivery only when checkout
    //   offers it. Every delivery offers it today; a switch added to that
    //   rule reaches this fact with no change here.
    cashOnDelivery: paymentOptionsFor({
      fulfilment: "delivery",
      onlineAvailable: online,
      policy: normalizePickupPayment(resolved["fulfilment.pickupPayment"]),
    }).offline,
  };
}

async function photoAvailability(
  actor: MinkActorContext,
): Promise<{ allowed: boolean; reason: string | null }> {
  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    return {
      allowed: false,
      reason: "New photos need Media manage permission.",
    };
  }
  const rows = await withService((db) =>
    db.execute(sql`
      select enabled from mink_action_tool_access
      where store_id = ${actor.storeId}::uuid
        and tool_name = 'generate_media_image'
      limit 1
    `),
  );
  const enabled = Boolean(
    (rows.rows[0] as { enabled?: boolean } | undefined)?.enabled,
  );
  return enabled
    ? { allowed: true, reason: null }
    : {
        allowed: false,
        reason: "Image generation is not enabled for this store.",
      };
}

/** Pages a personalisation may write, in the order it buys them. */
export function eligiblePages(
  target: PersonalizationTarget,
  requested: readonly string[] | null,
  options: { photosOnly?: boolean } = {},
): PersonalizationTargetPage[] {
  const writable = target.pages.filter((page) => page.skipped === null);
  // ★ A PHOTOS-ONLY PASS TOUCHES NO WORDS, so a page the merchant edited is
  //   in by default: only its theme photos are candidates, never their own.
  if (options.photosOnly && !requested) {
    return writable.slice(0, MINK_PERSONALIZATION_MAX_PAGES);
  }
  if (requested) {
    // ★ A page the merchant has edited is only written when named, which is
    //   what the interview asks about: their own words are not theme text.
    //   Even then only the theme's own sections change (`themeSectionIds`).
    const named = new Set(requested);
    return writable
      .filter((page) => named.has(page.slug))
      .slice(0, MINK_PERSONALIZATION_MAX_PAGES);
  }
  // ★ THE HOMEPAGE TOO: an edited homepage waits for the merchant's yes like
  //   any edited page (the prompt's own rule), rather than being written
  //   because it matters most.
  return writable
    .filter((page) => !page.edited)
    .slice(0, MINK_PERSONALIZATION_MAX_PAGES);
}

/** The interview summary the model reads. Never a credit figure. */
export function summarizePersonalizationTarget(target: PersonalizationTarget) {
  const counter = newRefCounter();
  const inventories = target.pages
    .filter((page) => page.skipped === null)
    .map((page) => ({
      page,
      inventory: buildPageInventory(
        page.slug,
        page.title,
        page.sections,
        counter,
        new Set(page.themeSectionIds),
      ),
    }));
  const defaultPages = eligiblePages(target, null).map((page) => page.slug);
  const chromeText = hasChromeText(target.chrome.value) || hasBrandText(target);
  const photos = inventories.flatMap(({ inventory }) => inventory.photos);
  const budget = planPersonalizationBudget({
    remaining: target.headroom.remaining,
    pages: defaultPages,
    design: true,
    chrome: chromeText,
    categoryCount: 0,
    photos: target.photos.allowed
      ? photos.filter((photo) => defaultPages.includes(photo.pageSlug))
      : [],
  });
  const photosThisTime = budget.included.filter(
    (item) => item.kind === "photo",
  ).length;
  const design = describeMinkStorefrontDesign(
    target.chrome.value.design ?? EMPTY_DESIGN_OVERRIDES,
    target.themeDesign,
  );
  return {
    store: { name: target.storeName, theme: target.themeName },
    pages: inventories.map(({ page, inventory }) => ({
      slug: page.slug,
      title: page.title,
      live: page.status === "published",
      editedByMerchant: page.edited,
      includedByDefault: defaultPages.includes(page.slug),
      // Sections the merchant wrote or changed: they keep their words.
      merchantSections: page.sections.filter(
        (section) =>
          section.enabled && !page.themeSectionIds.includes(section.id),
      ).length,
      textFields: inventory.texts.length + inventory.lists.length,
      themePhotos: inventory.photos.length,
      sampleSectionsToHide: inventory.hidden.map((hiddenSection) => ({
        type: hiddenSection.type,
        reason: hiddenSection.reason,
      })),
    })),
    neverChanged: target.pages
      .filter((page) => page.skipped !== null)
      .map((page) => ({
        slug: page.slug,
        reason:
          page.skipped === "policy"
            ? "A store policy: edit it under Settings, Policies."
            : "Its Builder draft has a problem: fix it in Website Builder first.",
      })),
    header: {
      announcement: target.chrome.value.header.announcement.enabled
        ? target.chrome.value.header.announcement.text ||
          "(the theme's announcement)"
        : null,
      newsletterHeading: target.chrome.value.footer.newsletter.enabled
        ? target.chrome.value.footer.newsletter.heading
        : null,
      tagline: target.brand.tagline,
      footerDescription: target.brand.blurb,
    },
    look: {
      designDigest: design.designDigest,
      current: design.current,
      themeDefaults: design.themeDefaults,
      contrastIssues: design.contrastIssues,
      fonts: design.vocabulary.fonts,
      fontPairings: Object.values(FONT_PAIRINGS).map((pairing) => ({
        display: pairing.display,
        body: pairing.body,
        label: pairing.label,
        moods: pairing.moods,
      })),
      minContrast: design.vocabulary.minContrast,
    },
    categories:
      target.categories?.map((category) => ({
        slug: category.slug,
        name: category.name,
        description: category.description,
        visible: category.status === "active",
        fromTheme: category.sample,
        products: category.productCount,
        hasPhoto: Boolean(category.imageUrl),
      })) ?? null,
    sampleProducts: target.sampleProducts
      ? {
          live: target.sampleProducts.filter(
            (product) => product.status === "published",
          ).length,
          drafts: target.sampleProducts.filter(
            (product) => product.status !== "published",
          ).length,
          names: target.sampleProducts
            .slice(0, 12)
            .map((product) => product.name),
        }
      : null,
    storeFacts: target.facts,
    photos: {
      themePhotoSlots: photos.length,
      newPhotosThisTime: photosThisTime,
      available: target.photos.allowed,
      ...(target.photos.reason
        ? { unavailableReason: target.photos.reason }
        : {}),
      ...(budget.unaffordable.length
        ? {
            note: "Not every photo fits this time: the most visible ones come first. Offer to make the rest later.",
          }
        : {}),
    },
  };
}

export function hasChromeText(chrome: StoreChrome): boolean {
  return chrome.header.announcement.enabled || chrome.footer.newsletter.enabled;
}

function hasBrandText(target: PersonalizationTarget): boolean {
  return Boolean(target.brand.tagline || target.brand.blurb);
}

export function assertBuilderAccess(
  actor: MinkActorContext,
  action: "view" | "manage",
) {
  if (action === "manage" && actor.draftingEnabled !== true) {
    throw new MinkToolInputError("Mink AI drafting is not enabled.");
  }
  if (!can(actor.permissions, "builder", action, actor.isSuperadmin)) {
    throw new MinkToolInputError(
      action === "manage"
        ? "You need Website Builder manage permission to personalise the storefront."
        : "You need Website Builder access to read the storefront.",
    );
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
