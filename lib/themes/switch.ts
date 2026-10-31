import "server-only";
import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { storeChrome, storePages, stores } from "@/drizzle/schema";
import { normalizeChrome, type StoreChrome } from "@/lib/chrome/types";
import { effectivePlan, planAllows, PLAN_META, type Plan } from "@/lib/plans";
import {
  isDemoStore,
  isStoreLaunched,
  isThemePending,
} from "@/lib/store/launch-state";
import { studioPreviewMarker } from "@/lib/theme-studio/preview-store";
import { logError } from "@/lib/observability/logger";
import type { StoredThemeInstallation } from "./meta";
import { prepareSections, revalidateThemeSeed, seedMenus } from "./apply";
import {
  homepageBackupSlug,
  planThemeSwitch,
  type ThemeSwitchFacts,
  type ThemeSwitchPlan,
} from "./switch-rules";
import type { ThemeDefinition } from "./types";

// ---------------------------------------------------------------------------
// Install a store's first theme from the dashboard's Storefront page
// (/dashboard/storefront).
//
// What may change is decided by the pure rules in switch-rules.ts; this module
// reads the facts those rules need and performs the writes. Every read and
// write carries the trusted store id and runs under the service scope, after
// the caller's `themes` manage gate (app/actions/theme-actions.ts).
//
// ★★ A THEME IS CHOSEN ONCE (owner, 31 Oct 2026). A store that already has a
// theme keeps it: switching to another is refused here, whatever the page
// offered, and the store changes how it looks through Customise storefront
// (a Mink AI redesign) and the Website Builder. There is no switch plan.
//
// ★ THE DESIGN WRITE IS THE ONE THAT MUST LAND. Everything after it is
// best-effort and reported, the applyThemeDefinition model: a store with the
// new design and its old homepage is coherent, and a failed homepage write
// never loses the old one.
//
// ★★ NO SAMPLE CATALOGUE (owner, 31 Oct 2026). A theme's sample products and
// categories are for demo and preview stores only (lib/themes/apply.ts). Here
// a theme brings its design, pages and menus, and its menus and page buttons
// arrive without their links to samples this store does not have. Samples
// older installs left behind are removed by lib/themes/sample-cleanup.ts.
// ---------------------------------------------------------------------------

export interface ThemeSwitchContext {
  storeId: string;
  settings: Record<string, unknown>;
  plan: Plan;
  /** Demo and Theme Studio preview stores are seeded by operators. */
  managedByOperators: boolean;
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
 *  Builder. They sit on top of any theme, so an install leaves them. */
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
 * Everything the install rules need about a store, read fresh. Null when the
 * store row cannot be found. Throws on a database error so the caller reports
 * an outage rather than deciding from a guess.
 */
export async function loadThemeSwitchContext(
  storeId: string,
): Promise<ThemeSwitchContext | null> {
  const [storeRows, pageRows, chromeRows, homeRows] = await Promise.all([
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
        .select({ slug: storePages.slug })
        .from(storePages)
        .where(eq(storePages.storeId, storeId)),
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
  const store = storeRows[0];
  if (!store) return null;
  const settings = isRecord(store.settings) ? store.settings : {};

  const chrome = chromeRows[0];
  const hasDesignOverrides = chrome
    ? chromeHasDesignOverrides(normalizeChrome(chrome.draft)) ||
      (chrome.published !== null &&
        chromeHasDesignOverrides(normalizeChrome(chrome.published)))
    : false;

  const homeRow = homeRows[0];
  const brand = isRecord(settings.brand) ? settings.brand : {};
  const brandColor =
    typeof brand.primaryColor === "string" ? brand.primaryColor.trim() : "";

  const facts: ThemeSwitchFacts = {
    firstTheme: isThemePending({ settings }),
    launched: isStoreLaunched({ settings }),
    // ★ No theme ever wrote the homepage, so the seed timestamps prove
    // nothing: a row with sections is the merchant's own work, and an empty
    // one (the blank draft the Website Builder creates) is as good as none.
    homepage:
      homeRow &&
      (hasSections(homeRow.sections) || hasSections(homeRow.publishedSections))
        ? "edited"
        : "missing",
    hasBuilderChrome: !!chrome,
    brandColorUnset: !brandColor,
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
    facts,
    homepage: homeRow ? { sections: homeRow.sections } : null,
    pageSlugs: new Set(pageRows.map((row) => row.slug)),
  };
}

export type ThemeSwitchResult =
  | { ok: true; plan: ThemeSwitchPlan; warnings: string[] }
  | { ok: false; error: string };

/** Said when a store that already has a theme asks for another. */
export const THEME_ALREADY_CHOSEN_MESSAGE =
  "Your store already has its theme. You can change how it looks with Customise storefront or the Website Builder.";

/**
 * Install `theme` as the store's first theme, while settings.themePending is
 * set. A store that already has a theme is refused (a theme is chosen once).
 * The caller has already checked that the theme is in the public catalogue and
 * that the actor may manage themes.
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
  // ★ Before anything else is judged: a store with a theme keeps it. The
  // design write below checks again under the row lock, so a second tab that
  // chose a theme a moment ago is refused there too.
  if (!ctx.facts.firstTheme) {
    return { ok: false, error: THEME_ALREADY_CHOSEN_MESSAGE };
  }
  if (!planAllows(ctx.plan, input.minPlan)) {
    return {
      ok: false,
      error: `${theme.name} needs the ${PLAN_META[input.minPlan!].name} plan or above.`,
    };
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
      // one since, this install would add pages to a store that already has
      // its theme: stop before writing anything.
      if (!isThemePending({ settings })) {
        throw new ThemeAlreadyChosen();
      }
      const brand = isRecord(settings.brand) ? settings.brand : {};
      const nextBrand: Record<string, unknown> =
        plan.brandColor === "theme"
          ? { ...brand, primaryColor: theme.preset.brand.primaryColor }
          : { ...brand };
      // What signup's theme seed used to fill in, and only where empty: the
      // AI brand voice reads these, and never over the merchant's.
      if (nextBrand.tagline == null && theme.preset.brand.tagline) {
        nextBrand.tagline = theme.preset.brand.tagline;
      }
      if (nextBrand.blurb == null && theme.preset.brand.blurb) {
        nextBrand.blurb = theme.preset.brand.blurb;
      }
      // ★★ THE PIN AND THE END OF "STORE IN PROGRESS" ARE ONE WRITE. Cleared
      // anywhere else, a failure between the two would leave a store with a
      // theme that still shows the in-progress page, or one with no theme
      // that has stopped showing it.
      const kept = { ...settings };
      delete kept.themePending;
      // The homepage write below records its own seed moment; a first install
      // has no earlier one to carry, whatever a stray key says.
      const installation: StoredThemeInstallation = {
        presetId: theme.id,
        presetVersion: theme.release.version,
        engineId: theme.engine.id,
        engineVersion: theme.engine.version,
        appliedAt: new Date().toISOString(),
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
        "We couldn't set up your theme. Nothing was changed. Please try again.",
    };
  }

  // --- 2. Menus, which link to the catalogue ---------------------------------
  // ★ Without links to the theme's sample catalogue, which this store does
  // not have (lib/themes/sample-links.ts).
  if (plan.menus === "replace") {
    await seedMenus(storeId, theme, actorUserId, fail, {
      withoutSampleLinks: true,
    });
  }

  // --- 3. The homepage: kept, or backed up and replaced in ONE transaction ---
  if (plan.homepage !== "keep") {
    const prepared = prepareSections(theme, "", { withoutSampleLinks: true });
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

  // --- 4. The theme's other pages the store does not have yet -----------------
  // ★ Free slugs only. The merchant may already have written their policies
  // (Settings → Policies) at slugs a theme could also ship; those pages are
  // theirs and the go-live checklist reads them.
  for (const page of theme.preset.pages) {
    if (page.slug === "" || ctx.pageSlugs.has(page.slug)) continue;
    const prepared = prepareSections(theme, page.slug, {
      withoutSampleLinks: true,
    });
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

  revalidateThemeSeed();
  return { ok: true, plan, warnings };
}
