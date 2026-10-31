// ---------------------------------------------------------------------------
// Installing or switching a store's theme: WHAT is allowed to change.
//
// Pure. `lib/themes/switch.ts` reads the facts and writes the result; the
// dashboard's confirm dialog shows `describeThemeSwitch` so the merchant reads
// exactly what the server will do. Both call `planThemeSwitch`, so the dialog
// cannot promise one thing while the server does another.
//
// ★★ A THEME IS A DESIGN; THE STORE'S CONTENT IS THE MERCHANT'S. Since
// 2026-10-11 signup installs no theme at all (settings.themePending): the
// owner's FIRST choice on Dashboard → Storefront installs one, and only then
// does the storefront stop showing its "store in progress" page. Stores made
// before that started on the platform default and switch from it here. Either
// way a theme's starting content comes with it ONLY where nothing of the
// merchant's would be lost:
//
//   • the design (colours, fonts, layout) always changes;
//   • the homepage is replaced while it is still the seed, and an edited one
//     only on request, and then only after it is kept as a draft page;
//   • ★★ NO SAMPLE CATALOGUE EVER ARRIVES (owner, 31 Oct 2026: the theme's
//     sample products and categories "should not be visible anywhere in the
//     dashboard at all"). A switch REMOVES the old theme's samples, and only
//     while the store has nothing but those untouched samples and has never
//     taken an order (stores that installed a theme before this still have
//     them); it adds none of the new theme's;
//   • the menus follow the catalogue, because a store's own menus may link to
//     its categories, and never replace a header and footer edited in the
//     Website Builder. The theme's menus arrive without their links to the
//     theme's sample catalogue (lib/themes/sample-links.ts);
//   • the brand colour follows the theme only while it is still the theme's.
//
// A FIRST install (no theme yet) follows the same rule from an empty start:
// the homepage is created unless the merchant already built one, the theme's
// pages fill only free slugs (policies written in Settings → Policies live at
// those slugs and stay), no samples are added, and the theme's menus arrive
// unless a Website Builder header and footer exist.
//
// Products, categories, pages and menus the merchant made are never touched.
// ---------------------------------------------------------------------------

/** How long after the theme writes the homepage a save still counts as the
 *  theme's own. The seed publishes in the same second it writes the row, so
 *  anything later than this is somebody's edit. */
export const SEED_WINDOW_MS = 60_000;

export interface HomepageTimes {
  createdAt: string;
  updatedAt: string;
}

/**
 * When the theme last wrote the homepage: the installation's own record of it
 * (`settings.theme.homepageSeededAt`, written by every seed and by a theme
 * switch that replaces the homepage), otherwise the row's creation time, which
 * is the signup seed for a store created before the record existed.
 *
 * ★ Without the record, a theme switch that replaced the homepage would leave
 * `updated_at` far from `created_at`, and the next read would call the theme's
 * own homepage "edited": the go-live checklist would tick "Personalise your
 * homepage" for the merchant, and the next switch would refuse to replace it.
 */
export function homepageSeedTime(
  settings: unknown,
  home: HomepageTimes,
): number {
  const created = Date.parse(home.createdAt);
  const theme =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).theme
      : null;
  const recorded =
    theme && typeof theme === "object" && !Array.isArray(theme)
      ? (theme as Record<string, unknown>).homepageSeededAt
      : null;
  const seeded = typeof recorded === "string" ? Date.parse(recorded) : NaN;
  if (
    Number.isFinite(seeded) &&
    (!Number.isFinite(created) || seeded > created)
  ) {
    return seeded;
  }
  return created;
}

/** Has anyone saved the homepage since the theme wrote it? A store with no
 *  homepage row has nothing of the merchant's on it. */
export function homepageEditedSinceSeed(
  settings: unknown,
  home: HomepageTimes | undefined,
): boolean {
  if (!home) return false;
  const seeded = homepageSeedTime(settings, home);
  const updated = Date.parse(home.updatedAt);
  if (!Number.isFinite(seeded) || !Number.isFinite(updated)) return false;
  return Math.abs(updated - seeded) > SEED_WINDOW_MS;
}

export interface ThemeSwitchFacts {
  /**
   * The store has no theme yet (`isThemePending`: settings.themePending), so
   * this is its FIRST install, and the storefront shows a "store in progress"
   * page until it lands.
   */
  firstTheme: boolean;
  /** The store has opened (settings.launched), so shoppers see changes now. */
  launched: boolean;
  /**
   * On a first install no theme ever wrote the homepage, so a row with any
   * sections is the merchant's ("edited") and an empty one, such as the
   * blank draft the Website Builder opens, counts as "missing".
   */
  homepage: "missing" | "seeded" | "edited";
  /**
   * The store holds at least one of the CURRENT theme's untouched samples,
   * every product and category in it is one, and it has never taken an
   * order. Only then does a switch remove them.
   */
  catalogueIsSampleOnly: boolean;
  /** The header and footer are edited in the Website Builder (a
   *  `store_chrome` row), so the theme's menus would not show anyway. */
  hasBuilderChrome: boolean;
  /** `brand.primaryColor` is unset or still the current theme's accent. With
   *  no theme yet (a first install) that means unset. */
  brandColorIsTheme: boolean;
  /** Colours, fonts or layout chosen in the Website Builder, which stay on
   *  top of any theme. Said in the dialog, never cleared by a switch. */
  hasDesignOverrides: boolean;
}

export interface ThemeSwitchOptions {
  /** The merchant asked for an EDITED homepage to be replaced too. */
  replaceEditedHomepage: boolean;
}

export interface ThemeSwitchPlan {
  /** The store's first theme: the same write that pins it deletes
   *  settings.themePending, which ends the "store in progress" page. */
  firstTheme: boolean;
  homepage: "replace" | "backup-and-replace" | "keep";
  /** Add the theme's pages the store does not have yet. Alongside a replaced
   *  homepage, whose links may point at them, and always on a first install,
   *  which has none of them. Never overwrites a page. */
  addMissingPages: boolean;
  /** "remove-samples" deletes the current theme's untouched samples on a
   *  switch. No plan ever adds samples to a merchant's store. */
  catalogue: "remove-samples" | "keep";
  menus: "replace" | "keep";
  brandColor: "theme" | "keep";
}

export function planThemeSwitch(
  facts: ThemeSwitchFacts,
  options: ThemeSwitchOptions,
): ThemeSwitchPlan {
  const homepage =
    facts.homepage === "edited"
      ? options.replaceEditedHomepage
        ? "backup-and-replace"
        : "keep"
      : "replace";
  if (facts.firstTheme) {
    // ★ No samples, ever. The theme's menus arrive without their links to
    // its sample catalogue, so they need no catalogue to be right; only a
    // Builder header and footer, which are the merchant's, keep them out.
    return {
      firstTheme: true,
      homepage,
      addMissingPages: true,
      catalogue: "keep",
      menus: facts.hasBuilderChrome ? "keep" : "replace",
      brandColor: facts.brandColorIsTheme ? "theme" : "keep",
    };
  }
  const catalogue = facts.catalogueIsSampleOnly ? "remove-samples" : "keep";
  return {
    firstTheme: false,
    homepage,
    addMissingPages: homepage !== "keep",
    catalogue,
    // ★ The old menus link to the old samples. Removing one without the
    // other leaves dead links in the header, and a Builder-edited header is
    // the merchant's.
    menus:
      catalogue === "remove-samples" && !facts.hasBuilderChrome
        ? "replace"
        : "keep",
    brandColor: facts.brandColorIsTheme ? "theme" : "keep",
  };
}

/**
 * The confirm dialog's account of a switch, one sentence per thing that
 * changes or deliberately does not. Built from the same plan the server runs.
 */
export function describeThemeSwitch(
  themeName: string,
  facts: ThemeSwitchFacts,
  plan: ThemeSwitchPlan,
): string[] {
  const first = plan.firstTheme;
  const lines = [
    first
      ? `Your storefront gets ${themeName}'s colours, fonts and layout, and stops showing the store-in-progress page.`
      : `Your storefront's colours, fonts and layout change to ${themeName}.`,
  ];
  if (facts.hasDesignOverrides) {
    lines.push(
      "Colours, fonts and layouts you chose in the Website Builder stay as they are. Reset them there to use the theme's.",
    );
  }
  if (plan.homepage === "replace") {
    lines.push(
      facts.homepage === "missing"
        ? `Your homepage is created from ${themeName}'s starting design.`
        : `Your homepage is replaced with ${themeName}'s starting homepage. You haven't edited it yet, so nothing of yours is lost.`,
    );
  } else if (plan.homepage === "backup-and-replace") {
    lines.push(
      `Your edited homepage is saved as a draft page called "Homepage before ${themeName}", then replaced with ${themeName}'s.`,
    );
  } else {
    lines.push(
      "Your homepage keeps its sections and their new look. Redesign it any time in the Website Builder.",
    );
  }
  if (plan.addMissingPages) {
    lines.push(
      first
        ? `${themeName}'s starting pages are added where your store doesn't have a page yet. Pages you've already written, like your policies, are not changed.`
        : `${themeName}'s other starting pages are added where your store doesn't have one. Your existing pages are not changed.`,
    );
  }
  lines.push(
    plan.catalogue === "remove-samples"
      ? `Your previous theme's sample products and categories are removed. ${themeName} adds no samples, so your dashboard shows only what you add.`
      : first
        ? "No sample products or categories are added, so your dashboard shows only what you add."
        : "Your products and categories are not changed, and no samples are added.",
  );
  if (plan.menus === "replace") {
    lines.push(
      first
        ? `Your header and footer menus are set up from ${themeName}'s.`
        : `Your header and footer menus change to ${themeName}'s.`,
    );
  } else if (facts.hasBuilderChrome) {
    lines.push(
      "Your header and footer stay as you set them in the Website Builder.",
    );
  }
  if (plan.brandColor === "keep") {
    lines.push("Your brand colour stays as you chose it.");
  } else if (first) {
    lines.push(
      `Your brand colour starts as ${themeName}'s. You can change it any time.`,
    );
  }
  if (facts.launched) {
    lines.push("Your store is open, so shoppers see the change straight away.");
  }
  if (first) lines.push("You can switch to another theme any time.");
  return lines;
}

/**
 * The slug of the draft page that keeps an edited homepage before a switch
 * replaces it. Unique per switch, and a valid custom-page slug (lower-case
 * words joined by hyphens).
 */
export function homepageBackupSlug(themeId: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 13); // 20261010-1530
  // Page slugs stop at 60 characters (PAGE_SLUG_MAX_LENGTH): the fixed parts
  // take 30, so a long Theme Studio id is shortened, never the timestamp.
  const id = themeId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return `homepage-before-${id || "theme"}-${stamp}`;
}
