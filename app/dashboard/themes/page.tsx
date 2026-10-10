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
import { getThemeCatalog } from "@/lib/themes/runtime-registry";
import { loadThemeSwitchContext } from "@/lib/themes/switch";
import { ThemesClient, type ThemeCard } from "./themes-client";

export const metadata = { title: "Themes" };

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

// Online Store → Themes, StoreMink's version. Every store starts on the
// platform default (signup no longer asks); this is where its owner picks the
// theme that fits, previews it on its demo store, and switches. What a switch
// may change is decided in lib/themes/switch-rules.ts, and the confirm dialog
// shows those exact rules before anything happens.
export default async function ThemesPage() {
  const access = await requireSectionAccess("themes", "view");
  const canManage = access.can("themes", "manage");
  const storeId = await getActingStoreId();

  const [catalog, context] = await Promise.all([
    getThemeCatalog(),
    loadThemeSwitchContext(storeId).catch((err) => {
      logError("themes.page_context", err, { storeId });
      return null;
    }),
  ]);
  const plan: Plan = context?.plan ?? "free";
  const currentId = context ? readThemeSelection(context.settings)?.id : null;
  const currentMeta = currentId
    ? (catalog.find((theme) => theme.id === currentId) ?? null)
    : null;

  // The library is the public catalogue, newest first, without the theme the
  // store already uses (it has its own card above).
  const library = newestThemesFirst(
    catalog.filter(
      (theme) =>
        theme.catalog.visibility === "public" && theme.id !== currentId,
    ),
  );

  return (
    <ThemesClient
      current={currentMeta ? toCard(currentMeta, plan) : null}
      currentId={currentId ?? null}
      library={library.map((theme) => toCard(theme, plan))}
      categories={themeCategoriesFor(library)}
      facts={context?.facts ?? null}
      canManage={canManage && !!context && !context.managedByOperators}
      managedByOperators={context?.managedByOperators ?? false}
      unavailable={!context}
    />
  );
}
