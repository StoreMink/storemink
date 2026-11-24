import { getActingStoreId, requireSectionAccess } from "../lib/access";
import { logError } from "@/lib/observability/logger";
import { planAllows, PLAN_META, type Plan } from "@/lib/plans";
import {
  canPreviewTheme,
  newestThemesFirst,
  readThemeSelection,
  themeCategoriesFor,
  type ThemeMeta,
} from "@/lib/themes/meta";
import {
  getThemeCatalog,
  resolveInstalledThemeDefinition,
} from "@/lib/themes/runtime-registry";
import { loadThemeSwitchContext } from "@/lib/themes/switch";
import type { ThemeDefinition } from "@/lib/themes/types";
import { StorefrontClient, type ThemeCard } from "./storefront-client";

export const metadata = { title: "Storefront" };

function toCard(theme: ThemeMeta, plan: Plan): ThemeCard {
  const minPlan = theme.catalog.minPlan;
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    previewImage: theme.catalog.previewImage,
    industries: theme.catalog.industries,
    minPlanName: minPlan ? PLAN_META[minPlan].name : null,
    locked: !planAllows(plan, minPlan),
    previewSlug: canPreviewTheme(theme) ? theme.demo.slug : null,
    previewUnavailableReason: canPreviewTheme(theme)
      ? null
      : theme.demo.unavailableReason || "Preview is temporarily unavailable",
  };
}

/**
 * ★ A theme no longer in the library (deleted in Theme Studio, owner, 23 Nov
 * 2026) is still the store's: the deletion keeps the release the store
 * installed (migration 0289), so its name and picture come from there. There
 * is nothing to preview: its demo store went with it.
 */
function keptCard(theme: ThemeDefinition): ThemeCard {
  return {
    id: theme.id,
    name: theme.name,
    description:
      "Your store uses a theme that is no longer in the library. It keeps working.",
    previewImage: theme.catalog.previewImage,
    industries: theme.catalog.industries,
    minPlanName: null,
    locked: false,
    previewSlug: null,
    previewUnavailableReason: null,
  };
}

// Dashboard → Storefront (was "Themes" at /dashboard/themes, which now
// redirects here; the permission key is still `themes`). A new store starts
// with NO theme (settings.themePending) and its storefront shows a "store in
// progress" page until its owner picks one here. ★★ A theme is chosen once
// (owner, 31 Oct 2026): the library is offered only while the store has none,
// and lib/themes/switch.ts refuses a second choice. Afterwards the page offers
// Customise storefront (a Mink AI redesign, Website Builder manage), the
// Website Builder and Branding, which sits under Storefront. What an install
// may change is decided in lib/themes/switch-rules.ts, and the confirm dialog
// shows those exact rules before anything happens.
export default async function StorefrontPage() {
  const access = await requireSectionAccess("themes", "view");
  const canManage = access.can("themes", "manage");
  const canEditBranding = access.can("branding", "view");
  const storeId = await getActingStoreId();

  const [catalog, context] = await Promise.all([
    getThemeCatalog(),
    loadThemeSwitchContext(storeId).catch((err) => {
      logError("themes.page_context", err, { storeId });
      return null;
    }),
  ]);
  const plan: Plan = context?.plan ?? "free";
  // ★ A pending store has no current theme, whatever `settings.theme` says: a
  // stray key must not render an "In use" card.
  const currentId =
    context && !context.facts.firstTheme
      ? (readThemeSelection(context.settings)?.id ?? null)
      : null;
  const currentMeta = currentId
    ? (catalog.find((theme) => theme.id === currentId) ?? null)
    : null;
  // Read only when the library no longer has the store's theme. A failed
  // read keeps the page: the card then names the theme by its id.
  const kept =
    currentId && !currentMeta && context
      ? await resolveInstalledThemeDefinition(
          readThemeSelection(context.settings),
        ).catch((err) => {
          logError("themes.page_installed_theme", err, { storeId });
          return null;
        })
      : null;
  const pending = context?.facts.firstTheme === true;
  const operatorStore = !context || context.managedByOperators;

  // The library is the public catalogue, newest first, and only while the
  // store has no theme to keep.
  const library = pending
    ? newestThemesFirst(
        catalog.filter((theme) => theme.catalog.visibility === "public"),
      )
    : [];

  return (
    <StorefrontClient
      current={
        currentMeta ? toCard(currentMeta, plan) : kept ? keptCard(kept) : null
      }
      currentId={currentId}
      library={library.map((theme) => toCard(theme, plan))}
      categories={themeCategoriesFor(library)}
      facts={context?.facts ?? null}
      canManage={canManage && !operatorStore}
      // A redesign needs a theme to redesign, and a merchant's store.
      canCustomise={
        access.can("builder", "manage") && !operatorStore && !pending
      }
      canEditBranding={canEditBranding}
      managedByOperators={context?.managedByOperators ?? false}
      unavailable={!context}
    />
  );
}
