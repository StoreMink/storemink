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
import {
  isDemoStore,
  isStoreLaunched,
  isThemePending,
} from "@/lib/store/launch-state";
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
// Install a store's first theme, or switch it to another, from the
// dashboard's Storefront page (/dashboard/storefront).
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

function hasSections(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** The first-install write found the store already has a theme. */
class ThemeAlreadyChosen extends Error {}

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
  const firstTheme = isThemePending({ settings });

  // A store still waiting for its first theme has none, whatever a stray key
  // might say, so nothing of an "old" theme is ever swapped out of it.
  const currentTheme = firstTheme
    ? null
    : await resolveInstalledThemeDefinition(readThemeSelection(settings)).catch(
        (err) => {
          // A theme that no longer resolves only means its samples and accent
          // are unknown, so nothing of the old theme is swapped. Never a refusal.
          logError("themes.switch_current_theme", err, { storeId });
          return null;
        },
      );
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
          .select({
            sections: storePages.sections,
            publishedSections: storePages.publishedSections,
          })
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
  const homeRow = homeRows[0];
  const brand = isRecord(settings.brand) ? settings.brand : {};
  const brandColor =
    typeof brand.primaryColor === "string"
      ? brand.primaryColor.trim().toLowerCase()
      : "";
  const themeColor =
    currentTheme?.preset.brand.primaryColor.trim().toLowerCase() ?? null;

  const facts: ThemeSwitchFacts = {
    firstTheme,
    launched: isStoreLaunched({ settings }),
    // ★ On a first install no theme ever wrote the homepage, so the seed
    // timestamps prove nothing: a row with sections is the merchant's own
    // work, and an empty one (the blank draft the Website Builder creates) is
    // as good as none.
    homepage: firstTheme
      ? homeRow &&
        (hasSections(homeRow.sections) ||
          hasSections(homeRow.publishedSections))
        ? "edited"
        : "missing"
      : !home
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
    catalogueIsEmpty:
      anyOrder.length === 0 && productTotal === 0 && categoryTotal === 0,
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
    homepage: homeRow ? { sections: homeRow.sections } : null,
    pageSlugs: new Set(pageRows.map((row) => row.slug)),
  };
}

export type ThemeSwitchResult =
  | { ok: true; plan: ThemeSwitchPlan; warnings: string[] }
  | { ok: false; error: string };

/**
 * Install `theme` on the store: its first theme while settings.themePending is
 * set, otherwise a switch. The caller has already checked that the theme is in
 * the public catalogue and that the actor may manage themes.
 */
export async function switchStoreThemeTo(input: {
  storeId: string;
  theme: ThemeDefinition;
  /** The catalogue's plan gate for this theme (undefined = every plan). */
  minPlan?: "basic" | "pro";
  replaceEditedHomepage: boolean;
  /**
   * What the confirm dialog described: a first install (true) or a switch
   * (false). ★ The dialog's lines come from facts loaded with the page, so a
   * tab opened while the store had no theme would promise first-install
   * behaviour after another tab had chosen one, and the server would do an
   * ordinary switch instead. A mismatch refuses before anything is written.
   * Undefined skips the check (a caller that showed no dialog).
   */
  expectFirstTheme?: boolean;
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
  if (
    input.expectFirstTheme !== undefined &&
    input.expectFirstTheme !== ctx.facts.firstTheme
  ) {
    return {
      ok: false,
      error: input.expectFirstTheme
        ? "A theme was just chosen for your store. Reload the page to see it."
        : "Your store changed since this page loaded. Reload the page and try again.",
    };
  }
  if (!planAllows(ctx.plan, input.minPlan)) {
    return {
      ok: false,
      error: `${theme.name} needs the ${PLAN_META[input.minPlan!].name} plan or above.`,
    };
  }
  // A store with no theme yet has nothing to be "already" on.
  const current = ctx.facts.firstTheme
    ? null
    : readThemeSelection(ctx.settings);
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
      // ★ The plan was made for a store with no theme. If another tab chose
      // one since, this install would add pages and samples to a store that
      // is no longer empty-handed: stop before writing anything.
      if (plan.firstTheme && !isThemePending({ settings })) {
        throw new ThemeAlreadyChosen();
      }
      // A first install has no earlier seed to carry, whatever a stray key says.
      const previous =
        !plan.firstTheme && isRecord(settings.theme) ? settings.theme : {};
      const brand = isRecord(settings.brand) ? settings.brand : {};
      const nextBrand: Record<string, unknown> =
        plan.brandColor === "theme"
          ? { ...brand, primaryColor: theme.preset.brand.primaryColor }
          : { ...brand };
      if (plan.firstTheme) {
        // What signup's theme seed used to fill in, and only where empty:
        // the AI brand voice reads these, and never over the merchant's.
        if (nextBrand.tagline == null && theme.preset.brand.tagline) {
          nextBrand.tagline = theme.preset.brand.tagline;
        }
        if (nextBrand.blurb == null && theme.preset.brand.blurb) {
          nextBrand.blurb = theme.preset.brand.blurb;
        }
      }
      // ★★ THE PIN AND THE END OF "STORE IN PROGRESS" ARE ONE WRITE. Cleared
      // anywhere else, a failure between the two would leave a store with a
      // theme that still shows the in-progress page, or one with no theme
      // that has stopped showing it.
      const kept = { ...settings };
      if (plan.firstTheme) delete kept.themePending;
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
            ...kept,
            template: theme.id,
            theme: installation,
            brand: nextBrand,
          },
        })
        .where(eq(stores.id, storeId));
    });
  } catch (err) {
    if (err instanceof ThemeAlreadyChosen) {
      return {
        ok: false,
        error:
          "A theme was just chosen for your store. Reload the page to see it.",
      };
    }
    logError("themes.switch_design", err, { storeId, themeId: theme.id });
    return {
      ok: false,
      error:
        "We couldn't switch your theme. Nothing was changed. Please try again.",
    };
  }

  // --- 2. The sample catalogue: seeded into an empty store on its first
  // install, or swapped while it is still only the old theme's samples -------
  if (plan.catalogue === "seed-samples") {
    // Drafts, as signup's seed made them: placeholders a customer never sees.
    await seedSampleCatalogue(storeId, theme, {
      actorUserId,
      publishSampleProducts: false,
      fail: (step, message) => fail(`samples (${step})`, message),
    });
  } else if (
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
  // ★ Free slugs only. On a first install the merchant may already have
  // written their policies (Settings → Policies) at slugs a theme could also
  // ship; those pages are theirs and the go-live checklist reads them.
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
