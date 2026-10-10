"use server";

/**
 * The dashboard's Themes page: switching a store to another theme.
 *
 * ⚠ EVERY EXPORT OF THIS FILE IS A PUBLICLY REACHABLE ENDPOINT, so the gate is
 * the boundary: a theme switch re-skins the whole storefront and may replace
 * its homepage. What the switch is allowed to change lives in
 * lib/themes/switch-rules.ts; this file only decides WHO may ask and WHICH
 * themes may be asked for.
 */

import { revalidatePath } from "next/cache";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
import { isThemeId, isThemeSelectable } from "@/lib/themes/meta";
import {
  getThemeCatalog,
  resolveThemeDefinition,
} from "@/lib/themes/runtime-registry";
import { switchStoreThemeTo } from "@/lib/themes/switch";
import type { ThemeSwitchPlan } from "@/lib/themes/switch-rules";

export type SwitchThemeResult =
  | {
      ok: true;
      themeName: string;
      plan: ThemeSwitchPlan;
      /** Parts that did not apply (logged); the design switch did. */
      warnings: string[];
    }
  | { ok: false; error: string };

export async function switchStoreTheme(
  themeId: unknown,
  options?: unknown,
): Promise<SwitchThemeResult> {
  const identity = await getManagerIdentity("themes");
  if (!identity) {
    return {
      ok: false,
      error: "You don't have permission to change the theme.",
    };
  }
  if (!isThemeId(themeId)) return { ok: false, error: "Choose a theme." };

  // ★ THE CATALOGUE DECIDES WHAT MAY BE INSTALLED, the rule createStore
  // follows: posting a hidden, draft or unknown id around the page must not
  // install it. `resolveThemeDefinition` alone would quietly substitute the
  // platform default for an id it does not know.
  const catalog = await getThemeCatalog();
  const meta = catalog.find(
    (theme) => theme.id === themeId && isThemeSelectable(theme),
  );
  if (!meta) return { ok: false, error: "That theme isn't available." };

  let theme;
  try {
    theme = await resolveThemeDefinition(meta.id);
  } catch (err) {
    logError("themes.switch_resolve", err, { themeId: meta.id });
    return {
      ok: false,
      error: "We couldn't load that theme. Please try again.",
    };
  }
  if (theme.id !== meta.id) {
    return { ok: false, error: "That theme isn't available." };
  }

  const replaceEditedHomepage =
    !!options &&
    typeof options === "object" &&
    (options as Record<string, unknown>).replaceEditedHomepage === true;

  const storeId = await getActingStoreId();
  const result = await switchStoreThemeTo({
    storeId,
    theme,
    minPlan: meta.catalog.minPlan,
    replaceEditedHomepage,
    actorUserId: identity.uid,
  });
  if (!result.ok) return result;

  revalidatePath("/dashboard/themes");
  revalidatePath("/dashboard");
  emitEvent({
    type: "settings.changed",
    storeId,
    actor: { type: "admin", id: identity.uid },
    payload: { settings: `Theme (${theme.name})`, count: 1 },
  });
  return {
    ok: true,
    themeName: theme.name,
    plan: result.plan,
    warnings: result.warnings,
  };
}
