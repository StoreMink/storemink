import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  categories,
  orders,
  products,
  storeChrome,
  storePages,
  stores,
} from "@/drizzle/schema";
import { normalizeChrome, type StoreChrome } from "@/lib/chrome/types";
import { effectivePlan, planAllows, PLAN_META, type Plan } from "@/lib/plans";
import { isDemoStore, isStoreLaunched } from "@/lib/store/launch-state";
import { studioPreviewMarker } from "@/lib/theme-studio/preview-store";
import { logError } from "@/lib/observability/logger";
import { readThemeSelection, type StoredThemeInstallation } from "./meta";
import { resolveInstalledThemeDefinition } from "./runtime-registry";
import {
  prepareSections,
  revalidateThemeSeed,
  seedMenus,
  seedSampleCatalogue,
} from "./apply";
import {
  homepageBackupSlug,
  homepageEditedSinceSeed,
  planThemeSwitch,
  SEED_WINDOW_MS,
  type ThemeSwitchFacts,
  type ThemeSwitchPlan,
} from "./switch-rules";
import type { ThemeDefinition } from "./types";

// ---------------------------------------------------------------------------
// Switch a live store to another theme from the dashboard's Themes page.
//
// What may change is decided by the pure rules in switch-rules.ts; this module
// reads the facts those rules need and performs the writes. Every read and
// write carries the trusted store id and runs under the service scope, after
// the caller's `themes` manage gate (app/actions/theme-actions.ts).
//
// ★ THE DESIGN SWITCH IS THE ONE WRITE THAT MUST LAND. Everything after it is
// best-effort and reported, the applyThemeDefinition model: a store with the
// new design and its old homepage is coherent, and a failed homepage write
// never loses the old one.
// ---------------------------------------------------------------------------

/** Theme samples are named "… (Sample)" by every bundled preset, the same
 *  marker the go-live checklist counts (lib/store/launch-checklist.ts). */
const SAMPLE_MARK = "%(Sample)%";
const SEED_WINDOW_SECONDS = SEED_WINDOW_MS / 1000;

export interface ThemeSwitchContext {
  storeId: string;
  settings: Record<string, unknown>;
  plan: Plan;
  /** Demo and Theme Studio preview stores are seeded by operators. */
  managedByOperators: boolean;
  /** The installed theme, when it still resolves (a retired one does not). */
  currentTheme: ThemeDefinition | null;
  facts: ThemeSwitchFacts;
  homepage: { sections: unknown } | null;
  pageSlugs: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Colours, fonts, radii or layouts the merchant chose in the Website
 *  Builder. They sit on top of any theme, so a switch leaves them. */
export function chromeHasDesignOverrides(chrome: StoreChrome): boolean {
  const { design, appearance } = chrome;
  return (
    Object.keys(design.palette).length > 0 ||
    design.fonts.body !== null ||
    design.fonts.display !== null ||
    Object.keys(design.shape).length > 0 ||
    appearance.header !== "theme" ||
    appearance.card !== "theme" ||
    appearance.productDetail !== "theme" ||
    appearance.cart !== "theme" ||
    appearance.footer !== "theme" ||
    Object.values(appearance.templates).some((value) => value !== "theme")
  );
}

/**
 * Everything the switch rules need about a store, read fresh. Null when the
 * store row cannot be found. Throws on a database error so the caller reports
 * an outage rather than deciding from a guess.
 */
export async function loadThemeSwitchContext(
  storeId: string,
): Promise<ThemeSwitchContext | null> {
  const [storeRows, pageRows] = await Promise.all([
    withService((db) =>
      db
        .select({
          settings: stores.settings,
          plan: stores.plan,
          planExpiresAt: stores.planExpiresAt,
          compPlan: stores.compPlan,
          compExpiresAt: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    ),
    withService((db) =>
      db
        .select({
          slug: storePages.slug,
          createdAt: storePages.createdAt,
          updatedAt: storePages.updatedAt,
        })
        .from(storePages)
        .where(eq(storePages.storeId, storeId)),
    ),
  ]);
  const store = storeRows[0];
  if (!store) return null;
  const settings = isRecord(store.settings) ? store.settings : {};

  const currentTheme = await resolveInstalledThemeDefinition(
    readThemeSelection(settings),
  ).catch((err) => {
    // A theme that no longer resolves only means its samples and accent are
    // unknown, so nothing of the old theme is swapped. Never a refusal.
    logError("themes.switch_current_theme", err, { storeId });
    return null;
  });
  const sampleProductSlugs =
    currentTheme?.preset.sampleData?.products.map((p) => p.slug) ?? [];
  const sampleCategorySlugs =
    currentTheme?.preset.sampleData?.categories.map((c) => c.slug) ?? [];

  // ★ A SAMPLE IS ONE NOBODY HAS TOUCHED: the current theme's slug, still
  // named "(Sample)", still a draft, and its content unchanged since it was
  // seeded. A merchant who published, renamed or rewrote one has made it
  // theirs, and the catalogue then counts as theirs too.
  const productSample =
    sampleProductSlugs.length > 0
      ? sql`${inArray(products.slug, sampleProductSlugs)}
          and ${products.name} like ${SAMPLE_MARK}
          and ${products.status} = 'draft'
          and abs(extract(epoch from (${products.contentUpdatedAt} - ${products.createdAt}))) <= ${SEED_WINDOW_SECONDS}`
      : sql`false`;
  const categorySample =
    sampleCategorySlugs.length > 0
      ? sql`${inArray(categories.slug, sampleCategorySlugs)}
          and abs(extract(epoch from (${categories.updatedAt} - ${categories.createdAt}))) <= ${SEED_WINDOW_SECONDS}`
      : sql`false`;

  const [productCounts, categoryCounts, anyOrder, chromeRows, homeRows] =
    await Promise.all([
      withService((db) =>
        db
          .select({
            total: sql<number>`count(*)`,
            samples: sql<number>`count(*) filter (where ${productSample})`,
          })
          .from(products)
          .where(eq(products.storeId, storeId)),
      ),
      withService((db) =>
        db
          .select({
            total: sql<number>`count(*)`,
            samples: sql<number>`count(*) filter (where ${categorySample})`,
          })
          .from(categories)
          .where(eq(categories.storeId, storeId)),
      ),
      withService((db) =>
        db
          .select({ id: orders.id })
          .from(orders)
          .where(eq(orders.storeId, storeId))
          .limit(1),
      ),
      withService((db) =>
        db
          .select({
            draft: storeChrome.draft,
            published: storeChrome.published,
          })
          .from(storeChrome)
          .where(eq(storeChrome.storeId, storeId))
          .limit(1),
      ),
      withService((db) =>
        db
          .select({ sections: storePages.sections })
          .from(storePages)
          .where(and(eq(storePages.storeId, storeId), eq(storePages.slug, "")))
          .limit(1),
      ),
    ]);

  const productTotal = Number(productCounts[0]?.total) || 0;
  const productSamples = Number(productCounts[0]?.samples) || 0;
  const categoryTotal = Number(categoryCounts[0]?.total) || 0;
  const categorySamples = Number(categoryCounts[0]?.samples) || 0;
  const chrome = chromeRows[0];
  const hasDesignOverrides = chrome
    ? chromeHasDesignOverrides(normalizeChrome(chrome.draft)) ||
      (chrome.published !== null &&
        chromeHasDesignOverrides(normalizeChrome(chrome.published)))
    : false;

  const home = pageRows.find((row) => row.slug === "");
  const brand = isRecord(settings.brand) ? settings.brand : {};
  const brandColor =
    typeof brand.primaryColor === "string"
      ? brand.primaryColor.trim().toLowerCase()
      : "";
  const themeColor =
    currentTheme?.preset.brand.primaryColor.trim().toLowerCase() ?? null;

  const facts: ThemeSwitchFacts = {
    launched: isStoreLaunched({ settings }),
    homepage: !home
      ? "missing"
      : homepageEditedSinceSeed(settings, home)
        ? "edited"
        : "seeded",
    // ★ Only a store that still HAS its samples and nothing else. One with an
    // empty catalogue (samples already deleted, as the checklist suggests) is
    // not given a new set it did not ask for.
    catalogueIsSampleOnly:
      anyOrder.length === 0 &&
      productTotal > 0 &&
      productTotal === productSamples &&
      categoryTotal === categorySamples,
    hasBuilderChrome: !!chrome,
    brandColorIsTheme: !brandColor || brandColor === themeColor,
    hasDesignOverrides,
  };

  return {
    storeId,
    settings,
    plan: effectivePlan({
      plan: store.plan,
      plan_expires_at: store.planExpiresAt,
      comp_plan: store.compPlan,
      comp_expires_at: store.compExpiresAt,
    }),
    managedByOperators:
      isDemoStore({ settings }) || studioPreviewMarker(settings) !== null,
    currentTheme,
    facts,
    homepage: homeRows[0] ?? null,
    pageSlugs: new Set(pageRows.map((row) => row.slug)),
  };
}

export type ThemeSwitchResult =
  | { ok: true; plan: ThemeSwitchPlan; warnings: string[] }
  | { ok: false; error: string };

/**
 * Switch the store to `theme`. The caller has already checked that the theme
 * is in the public catalogue and that the actor may manage themes.
 */
export async function switchStoreThemeTo(input: {
  storeId: string;
  theme: ThemeDefinition;
  /** The catalogue's plan gate for this theme (undefined = every plan). */
  minPlan?: "basic" | "pro";
  replaceEditedHomepage: boolean;
  actorUserId: string;
}): Promise<ThemeSwitchResult> {
  const { storeId, theme, actorUserId } = input;
  let ctx: ThemeSwitchContext | null;
  try {
    ctx = await loadThemeSwitchContext(storeId);
  } catch (err) {
    logError("themes.switch_context", err, { storeId });
    return {
      ok: false,
      error: "We couldn't read your store. Please try again.",
    };
  }
  if (!ctx) return { ok: false, error: "Store not found." };
  if (ctx.managedByOperators) {
    return {
      ok: false,
      error:
        "This store's theme is managed by StoreMink and can't be changed here.",
    };
  }
  if (!planAllows(ctx.plan, input.minPlan)) {
    return {
      ok: false,
      error: `${theme.name} needs the ${PLAN_META[input.minPlan!].name} plan or above.`,
    };
  }
  const current = readThemeSelection(ctx.settings);
  if (current?.id === theme.id) {
    return { ok: false, error: `${theme.name} is already your theme.` };
  }

  const plan = planThemeSwitch(ctx.facts, {
    replaceEditedHomepage: input.replaceEditedHomepage,
  });
  const warnings: string[] = [];
  const fail = (step: string, message: string) => {
    logError("themes.switch_step", new Error(message), {
      storeId,
      themeId: theme.id,
      step,
    });
    warnings.push(step);
  };

  // --- 1. The design. The one write that must land. --------------------------
  try {
    await withService(async (db) => {
      const [row] = await db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, storeId))
        .for("update");
      const settings = isRecord(row?.settings) ? row.settings : {};
      const previous = isRecord(settings.theme) ? settings.theme : {};
      const brand = isRecord(settings.brand) ? settings.brand : {};
      const installation: StoredThemeInstallation = {
        presetId: theme.id,
        presetVersion: theme.release.version,
        engineId: theme.engine.id,
        engineVersion: theme.engine.version,
        appliedAt: new Date().toISOString(),
        // Carried until the homepage is actually replaced below, which then
        // records its own moment; a kept homepage keeps its old baseline.
        ...(typeof previous.homepageSeededAt === "string"
          ? { homepageSeededAt: previous.homepageSeededAt }
          : {}),
      };
      await db
        .update(stores)
        .set({
          settings: {
            ...settings,
            template: theme.id,
            theme: installation,
            brand:
              plan.brandColor === "theme"
                ? { ...brand, primaryColor: theme.preset.brand.primaryColor }
                : brand,
          },
        })
        .where(eq(stores.id, storeId));
    });
  } catch (err) {
    logError("themes.switch_design", err, { storeId, themeId: theme.id });
    return {
      ok: false,
      error:
        "We couldn't switch your theme. Nothing was changed. Please try again.",
    };
  }

  // --- 2. The sample catalogue, while it is still only samples ---------------
  if (
    plan.catalogue === "swap-samples" &&
    ctx.currentTheme?.preset.sampleData
  ) {
    const oldProducts = ctx.currentTheme.preset.sampleData.products.map(
      (p) => p.slug,
    );
    const oldCategories = ctx.currentTheme.preset.sampleData.categories.map(
      (c) => c.slug,
    );
    let cleared = false;
    try {
      await withService(async (db) => {
        // The same narrow predicate the facts used: an untouched draft named
        // "(Sample)". Anything else stays, whatever its slug.
        if (oldProducts.length > 0) {
          await db
            .delete(products)
            .where(
              and(
                eq(products.storeId, storeId),
                inArray(products.slug, oldProducts),
                sql`${products.name} like ${SAMPLE_MARK}`,
                eq(products.status, "draft"),
              ),
            );
        }
        if (oldCategories.length > 0) {
          await db
            .delete(categories)
            .where(
              and(
                eq(categories.storeId, storeId),
                inArray(categories.slug, oldCategories),
              ),
            );
        }
      });
      cleared = true;
    } catch (err) {
      fail("samples", dbErrorMessage(err, "could not remove the old samples"));
    }
    if (cleared) {
      await seedSampleCatalogue(storeId, theme, {
        actorUserId,
        publishSampleProducts: false,
        fail: (step, message) => fail(`samples (${step})`, message),
      });
    }
  }

  // --- 3. Menus, which link to the catalogue ---------------------------------
  if (plan.menus === "replace") {
    await seedMenus(storeId, theme, actorUserId, fail);
  }

  // --- 4. The homepage: kept, or backed up and replaced in ONE transaction ---
  if (plan.homepage !== "keep") {
    const prepared = prepareSections(theme, "");
    const page = theme.preset.pages.find((p) => p.slug === "");
    if ("error" in prepared || !page) {
      fail(
        "homepage",
        "error" in prepared ? prepared.error : "theme has no homepage",
      );
    } else {
      try {
        await withService(async (db) => {
          // ★ The backup and the replacement commit together. If the backup
          // cannot be written, the edited homepage is not replaced.
          if (plan.homepage === "backup-and-replace" && ctx.homepage) {
            await db.insert(storePages).values({
              storeId,
              slug: homepageBackupSlug(theme.id, new Date()),
              title: `Homepage before ${theme.name}`,
              seoTitle: "",
              seoDescription: "",
              seoNoindex: true,
              sections: ctx.homepage.sections,
              createdBy: actorUserId,
              updatedBy: actorUserId,
            });
          }
          const publishedAt = new Date().toISOString();
          const [written] = await db
            .insert(storePages)
            .values({
              storeId,
              slug: "",
              title: page.title,
              seoTitle: page.seo_title ?? "",
              seoDescription: page.seo_description ?? "",
              seoNoindex: false,
              sections: prepared.sections,
              publishedSections: prepared.sections,
              status: "published",
              publishedAt,
              createdBy: actorUserId,
              updatedBy: actorUserId,
            })
            .onConflictDoUpdate({
              target: [storePages.storeId, storePages.slug],
              set: {
                title: page.title,
                seoTitle: page.seo_title ?? "",
                seoDescription: page.seo_description ?? "",
                sections: prepared.sections,
                publishedSections: prepared.sections,
                status: "published",
                publishedAt,
                updatedBy: actorUserId,
              },
            })
            .returning({ updatedAt: storePages.updatedAt });

          // Record the seed with the row's own timestamp, so the next read
          // sees the theme's homepage as untouched.
          const [row] = await db
            .select({ settings: stores.settings })
            .from(stores)
            .where(eq(stores.id, storeId))
            .for("update");
          const settings = isRecord(row?.settings) ? row.settings : {};
          const installed = isRecord(settings.theme) ? settings.theme : {};
          await db
            .update(stores)
            .set({
              settings: {
                ...settings,
                theme: { ...installed, homepageSeededAt: written?.updatedAt },
              },
            })
            .where(eq(stores.id, storeId));
        });
      } catch (err) {
        fail("homepage", dbErrorMessage(err, "could not replace the homepage"));
      }
    }
  }

  // --- 5. The theme's other pages the store does not have yet -----------------
  if (plan.addMissingPages) {
    for (const page of theme.preset.pages) {
      if (page.slug === "" || ctx.pageSlugs.has(page.slug)) continue;
      const prepared = prepareSections(theme, page.slug);
      if ("error" in prepared) {
        fail(`page ${page.slug}`, prepared.error);
        continue;
      }
      try {
        await withService((db) =>
          db
            .insert(storePages)
            .values({
              storeId,
              slug: page.slug,
              title: page.title,
              seoTitle: page.seo_title ?? "",
              seoDescription: page.seo_description ?? "",
              seoNoindex: false,
              sections: prepared.sections,
              publishedSections: prepared.sections,
              status: "published",
              publishedAt: new Date().toISOString(),
              createdBy: actorUserId,
              updatedBy: actorUserId,
            })
            // Never over a page of the merchant's, even one made a moment ago.
            .onConflictDoNothing({
              target: [storePages.storeId, storePages.slug],
            }),
        );
      } catch (err) {
        fail(`page ${page.slug}`, dbErrorMessage(err, "insert failed"));
      }
    }
  }

  revalidateThemeSeed();
  return { ok: true, plan, warnings };
}
