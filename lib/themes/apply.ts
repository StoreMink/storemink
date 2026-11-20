import { randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  categories,
  productVariants,
  products,
  storeMenus,
  storePages,
  stores,
} from "@/drizzle/schema";
import { STORE_TAG } from "@/lib/store/resolve";
import { TAGS } from "@/lib/storefront/tags";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { resolveOptionRows } from "@/lib/products/options";
import {
  validateSections,
  type PageSectionItem,
  type RichTextConfig,
} from "@/lib/sections/registry";
import { resolveThemeDefinition } from "./runtime-registry";
import {
  menusWithoutSampleLinks,
  sampleAddresses,
  sectionsWithoutSampleLinks,
} from "./sample-links";
import type { StoredThemeInstallation } from "./meta";
import type { ThemeDefinition } from "./types";

// ---------------------------------------------------------------------------
// applyTheme — seed (or re-seed) a store with a theme package: settings/brand,
// sample categories + products (+variants), menus, and pages (published).
//
// Design:
//  • SERVICE-ROLE scope (withService, BYPASSRLS), every write explicitly
//    store-scoped (same trust model as page-actions). Callers are trusted
//    server code only: the platform-operator seedDemoStore action and Theme
//    Studio publication. Signup installs no theme (2026-10-11); a store's
//    first theme goes through lib/themes/switch.ts, which composes this
//    module's exports so nothing the seller already made is overwritten.
//  • ★★ SAMPLES ARE FOR SHOWCASE STORES ONLY (owner, 31 Oct 2026). The demo
//    and Theme Studio preview stores get the theme's sample categories and
//    products; a merchant's store never does (switch.ts seeds no catalogue
//    and installs the menus and pages without links to it,
//    lib/themes/sample-links.ts).
//  • BEST-EFFORT per entity with an errors accumulator — entities are
//    independent (a store with products but a failed page is still coherent),
//    and every write is an idempotent upsert keyed on (store_id, slug), so
//    re-running applyTheme heals a partial apply. Each independent write runs
//    in its OWN withService transaction so one failure can't roll back the rest.
//  • reset:true (demo stores only — refuses unless settings.demo === true)
//    clears the store's catalog/menus/pages first so demos stay theme-pristine.
// ---------------------------------------------------------------------------

export interface ApplyThemeResult {
  success: boolean;
  errors: string[];
}

export interface ApplyThemeOptions {
  publish: boolean;
  actorUserId?: string | null;
  reset?: boolean;
  /**
   * Publish the theme's SAMPLE products (default: seed them as drafts).
   *
   * Only the demo stores want them live. A Theme Studio preview store keeps
   * them as drafts. A merchant's store gets none at all: it installs themes
   * through lib/themes/switch.ts, which never calls applyThemeDefinition.
   */
  publishSampleProducts?: boolean;
}

export async function applyTheme(
  storeId: string,
  themeId: unknown,
  options: ApplyThemeOptions,
): Promise<ApplyThemeResult> {
  return applyThemeDefinition(
    storeId,
    await resolveThemeDefinition(themeId),
    options,
  );
}

/**
 * Seed a store from a theme DEFINITION the caller already holds. applyTheme
 * resolves one from the registry; a Theme Studio preview passes a draft
 * version's definition, which the registry never serves.
 */
export async function applyThemeDefinition(
  storeId: string,
  theme: ThemeDefinition,
  {
    publish,
    actorUserId = null,
    reset = false,
    publishSampleProducts = false,
  }: ApplyThemeOptions,
): Promise<ApplyThemeResult> {
  const { preset } = theme;
  const errors: string[] = [];
  const fail = (step: string, message: string) => {
    console.error(`applyTheme(${theme.id}) ${step}:`, message);
    errors.push(`${step}: ${message}`);
  };

  // --- settings merge (template + brand accents; NEVER the store's name) ----
  let settings: Record<string, unknown>;
  try {
    const rows = await withService((db) =>
      db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    if (!rows[0]) {
      return { success: false, errors: ["store lookup: not found"] };
    }
    settings = (rows[0].settings as Record<string, unknown>) ?? {};
  } catch (err) {
    return {
      success: false,
      errors: [`store lookup: ${dbErrorMessage(err, "failed")}`],
    };
  }

  if (reset && settings.demo !== true) {
    return {
      success: false,
      errors: ["reset refused: store is not a demo store (settings.demo)"],
    };
  }

  const existingBrand = (settings.brand as Record<string, unknown>) ?? {};
  const installation: StoredThemeInstallation = {
    presetId: theme.id,
    presetVersion: theme.release.version,
    engineId: theme.engine.id,
    engineVersion: theme.engine.version,
    appliedAt: new Date().toISOString(),
  };
  // This call seeds the pages below, homepage included, in the same moment.
  // A theme switch reads this to tell the theme's homepage from the
  // merchant's (lib/themes/switch-rules.ts → homepageEditedSinceSeed).
  installation.homepageSeededAt = installation.appliedAt;
  const mergedSettings = {
    ...settings,
    // `template` remains for old readers and old stores. `theme` is the new
    // pinned installation contract; future releases must not silently rewrite
    // a merchant's storefront merely because the catalog advanced.
    template: theme.id,
    theme: installation,
    brand: {
      ...existingBrand, // keeps the merchant's chosen name/logo
      primaryColor: preset.brand.primaryColor,
      tagline: existingBrand.tagline ?? preset.brand.tagline ?? null,
      blurb: existingBrand.blurb ?? preset.brand.blurb ?? null,
    },
  };
  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ settings: mergedSettings })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    fail("settings", dbErrorMessage(err, "update failed"));
  }

  // --- reset (demo reseed) ---------------------------------------------------
  if (reset) {
    // products cascade their variants (FK); pages/menus/categories are flat.
    // Each delete runs in its own transaction so one failure can't abort the
    // rest (best-effort, mirroring the original per-request semantics).
    const resetTargets = [
      ["products", products],
      ["categories", categories],
      ["store_pages", storePages],
      ["store_menus", storeMenus],
    ] as const;
    for (const [label, table] of resetTargets) {
      try {
        await withService((db) =>
          db.delete(table).where(eq(table.storeId, storeId)),
        );
      } catch (err) {
        fail(`reset ${label}`, dbErrorMessage(err, "delete failed"));
      }
    }
  }

  // --- sample categories + products ------------------------------------------
  await seedSampleCatalogue(storeId, theme, {
    actorUserId,
    publishSampleProducts,
    fail,
  });

  // --- menus -------------------------------------------------------------------
  await seedMenus(storeId, theme, actorUserId, fail);

  // --- pages ---------------------------------------------------------------------
  for (const page of preset.pages) {
    const sections = prepareSections(theme, page.slug);
    if ("error" in sections) {
      fail(`page ${page.slug || "(home)"}`, sections.error);
      continue;
    }
    const insertRow: typeof storePages.$inferInsert = {
      storeId,
      slug: page.slug,
      title: page.title,
      seoTitle: page.seo_title ?? "",
      seoDescription: page.seo_description ?? "",
      seoNoindex: false,
      sections: sections.sections,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    const updateSet: Partial<typeof storePages.$inferInsert> = {
      title: page.title,
      seoTitle: page.seo_title ?? "",
      seoDescription: page.seo_description ?? "",
      seoNoindex: false,
      sections: sections.sections,
      updatedBy: actorUserId,
    };
    if (publish) {
      const publishedAt = new Date().toISOString();
      insertRow.publishedSections = sections.sections;
      insertRow.status = "published";
      insertRow.publishedAt = publishedAt;
      updateSet.publishedSections = sections.sections;
      updateSet.status = "published";
      updateSet.publishedAt = publishedAt;
    }
    try {
      await withService((db) =>
        db
          .insert(storePages)
          .values(insertRow)
          .onConflictDoUpdate({
            target: [storePages.storeId, storePages.slug],
            set: updateSet,
          }),
      );
    } catch (err) {
      fail(
        `page ${page.slug || "(home)"}`,
        dbErrorMessage(err, "upsert failed"),
      );
    }
  }

  // --- cache busting -----------------------------------------------------------
  revalidateThemeSeed();

  return { success: errors.length === 0, errors };
}

type FailFn = (step: string, message: string) => void;

/**
 * Seed (or re-seed) a theme's sample categories and products, upserted on
 * (store_id, slug). For the demo and Theme Studio preview stores only
 * (applyThemeDefinition): a merchant's store gets no samples.
 */
export async function seedSampleCatalogue(
  storeId: string,
  theme: ThemeDefinition,
  {
    actorUserId,
    publishSampleProducts,
    fail,
  }: {
    actorUserId: string | null;
    publishSampleProducts: boolean;
    fail: FailFn;
  },
): Promise<void> {
  const { preset } = theme;
  const categoryIdBySlug = new Map<string, string>();
  if (!preset.sampleData) return;
  for (const c of preset.sampleData.categories) {
    try {
      const [row] = await withService((db) =>
        db
          .insert(categories)
          .values({
            storeId,
            name: c.name,
            slug: c.slug,
            description: c.description ?? null,
            imageUrl: c.image_url ?? null,
            sortOrder: c.sort_order ?? 0,
            status: "active",
          })
          .onConflictDoUpdate({
            target: [categories.storeId, categories.slug],
            set: {
              name: c.name,
              description: c.description ?? null,
              imageUrl: c.image_url ?? null,
              sortOrder: c.sort_order ?? 0,
              status: "active",
            },
          })
          .returning({ id: categories.id, slug: categories.slug }),
      );
      if (!row) {
        fail(`category ${c.slug}`, "no row");
        continue;
      }
      categoryIdBySlug.set(row.slug, row.id);
    } catch (err) {
      fail(`category ${c.slug}`, dbErrorMessage(err, "upsert failed"));
    }
  }

  for (const p of preset.sampleData.products) {
    // Option axes seed exactly as the product editor saves them. A seed
    // whose combinations do not add up keeps its variants as a flat list
    // (and says so) rather than writing options the storefront would
    // refuse to render as pickers.
    const optionRows = resolveOptionRows(p.options, p.variants ?? []);
    if ("error" in optionRows) fail(`options ${p.slug}`, optionRows.error);
    const seedOptions = "error" in optionRows ? [] : optionRows.options;
    const seedVariants =
      "error" in optionRows
        ? (p.variants ?? []).map((v) => ({ ...v, option_values: [] }))
        : optionRows.variants;
    let productId: string;
    try {
      const [row] = await withService((db) =>
        db
          .insert(products)
          // sku / sku_no are NOT NULL but owned by the BEFORE-INSERT trigger
          // (products_set_sku) — the app never sends them, so the
          // insert type is asserted past those two columns.
          .values({
            storeId,
            name: p.name,
            slug: p.slug,
            description: p.description,
            categoryId: categoryIdBySlug.get(p.category_slug) ?? null,
            basePrice: p.base_price,
            sellingPrice: p.selling_price,
            imageUrl: p.image_url,
            images: p.images ?? [],
            status: publishSampleProducts ? "published" : "draft",
            featured: p.featured ?? false,
            sortOrder: p.sort_order ?? 0,
            cardColor: p.card_color ?? null,
            options: seedOptions,
            publishedAt: publishSampleProducts
              ? new Date().toISOString()
              : null,
            createdBy: actorUserId,
            updatedBy: actorUserId,
          } as typeof products.$inferInsert)
          .onConflictDoUpdate({
            target: [products.storeId, products.slug],
            set: {
              name: p.name,
              description: p.description,
              categoryId: categoryIdBySlug.get(p.category_slug) ?? null,
              basePrice: p.base_price,
              sellingPrice: p.selling_price,
              imageUrl: p.image_url,
              images: p.images ?? [],
              // Re-applying keeps the same publish rule as the first apply:
              // an unconditional "published" here would put a merchant's
              // draft sample products live on any re-seed.
              status: publishSampleProducts ? "published" : "draft",
              featured: p.featured ?? false,
              sortOrder: p.sort_order ?? 0,
              cardColor: p.card_color ?? null,
              options: seedOptions,
              publishedAt: publishSampleProducts
                ? new Date().toISOString()
                : null,
              updatedBy: actorUserId,
            },
          })
          .returning({ id: products.id }),
      );
      if (!row) {
        fail(`product ${p.slug}`, "no row");
        continue;
      }
      productId = row.id;
    } catch (err) {
      fail(`product ${p.slug}`, dbErrorMessage(err, "upsert failed"));
      continue;
    }

    // Replace variants (mirrors product-actions' replaceVariants). Clear and
    // insert are separate transactions so a clear failure still lets the
    // insert run, matching the original per-request best-effort behaviour.
    try {
      await withService((db) =>
        db
          .delete(productVariants)
          .where(
            and(
              eq(productVariants.storeId, storeId),
              eq(productVariants.productId, productId),
            ),
          ),
      );
    } catch (err) {
      fail(`variants(clear) ${p.slug}`, dbErrorMessage(err, "delete failed"));
    }

    const variants = seedVariants.map((v, i) => ({
      storeId,
      productId,
      name: v.name,
      basePrice: v.base_price,
      sellingPrice: v.selling_price,
      specialPrice: v.special_price ?? null,
      stock: v.stock,
      // sku / variant_no are trigger-owned; a null sku lets the trigger fill it.
      sku: v.sku ?? null,
      sortOrder: v.sort_order ?? i,
      images: v.images ?? [],
      optionValues: v.option_values,
    }));
    if (variants.length > 0) {
      try {
        await withService((db) =>
          db
            .insert(productVariants)
            .values(variants as (typeof productVariants.$inferInsert)[]),
        );
      } catch (err) {
        fail(`variants ${p.slug}`, dbErrorMessage(err, "insert failed"));
      }
    }
  }
}

/**
 * Upsert the theme's header and footer menus (store_menus).
 *
 * `withoutSampleLinks` is for a merchant's store, which gets no samples
 * (lib/themes/sample-links.ts): the menus then leave out every link to a
 * sample category or product, which would otherwise lead nowhere.
 */
export async function seedMenus(
  storeId: string,
  theme: ThemeDefinition,
  actorUserId: string | null,
  fail: FailFn,
  { withoutSampleLinks = false }: { withoutSampleLinks?: boolean } = {},
): Promise<void> {
  const menus = withoutSampleLinks
    ? menusWithoutSampleLinks(theme.preset.menus, sampleAddresses(theme))
    : theme.preset.menus;
  try {
    await withService((db) =>
      db
        .insert(storeMenus)
        .values({
          storeId,
          header: menus.header,
          footerGroups: menus.footerGroups,
          footerLegal: menus.footerLegal,
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: storeMenus.storeId,
          set: {
            header: menus.header,
            footerGroups: menus.footerGroups,
            footerLegal: menus.footerLegal,
            updatedBy: actorUserId,
          },
        }),
    );
  } catch (err) {
    fail("menus", dbErrorMessage(err, "upsert failed"));
  }
}

/** Every storefront cache a theme's seed touches. */
export function revalidateThemeSeed(): void {
  revalidateTag(STORE_TAG, "max");
  revalidateTag(TAGS.pages, "max");
  revalidateTag(TAGS.products, "max");
  revalidateTag(TAGS.categories, "max");
  revalidateTag(TAGS.menus, "max");
  revalidatePath("/");
}

/**
 * Validate a theme page's sections (strict publish mode), regenerate ids as
 * real UUIDs, and sanitize rich_text HTML — the same server rules every other
 * write path applies.
 *
 * `withoutSampleLinks` is for a merchant's store, which gets no samples: a
 * button or tile that pointed at a sample category or product goes to the
 * shop instead (lib/themes/sample-links.ts).
 */
export function prepareSections(
  theme: ThemeDefinition,
  pageSlug: string,
  { withoutSampleLinks = false }: { withoutSampleLinks?: boolean } = {},
): { sections: PageSectionItem[] } | { error: string } {
  const page = theme.preset.pages.find((p) => p.slug === pageSlug);
  if (!page) return { error: "page missing from theme" };

  const withIds = page.sections.map((s) => ({ ...s, id: randomUUID() }));
  const validated = validateSections(
    withoutSampleLinks
      ? sectionsWithoutSampleLinks(withIds, sampleAddresses(theme))
      : withIds,
    { mode: "publish" },
  );
  if ("error" in validated) return validated;

  return {
    sections: validated.sections.map((s) =>
      s.type === "rich_text"
        ? {
            ...s,
            config: {
              ...(s.config as RichTextConfig),
              html: sanitizeBlogContent((s.config as RichTextConfig).html),
            },
          }
        : s,
    ),
  };
}
