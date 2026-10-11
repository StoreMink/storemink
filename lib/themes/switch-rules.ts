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
//   • the sample catalogue is swapped only while the store has nothing but the
//     current theme's samples and has never taken an order;
//   • the menus follow the catalogue, because they link to its categories, and
//     never replace a header and footer edited in the Website Builder;
//   • the brand colour follows the theme only while it is still the theme's.
//
// A FIRST install (no theme yet) follows the same rule from an empty start:
// the homepage is created unless the merchant already built one, the theme's
// pages fill only free slugs (policies written in Settings → Policies live at
// those slugs and stay), and samples and menus arrive only in a store with no
// catalogue, no orders and no Website Builder header or footer.
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
   * Every product and category in the store is one of the CURRENT theme's
   * samples, and the store has never taken an order. Only then may the
   * starting catalogue be swapped for the new theme's.
   */
  catalogueIsSampleOnly: boolean;
  /** No products, no categories, and never an order. A first install seeds
   *  the theme's samples only into a store like this. */
  catalogueIsEmpty: boolean;
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
  /** "seed-samples" adds the theme's samples (products as drafts) to an empty
   *  store on its first install; "swap-samples" replaces the current theme's
   *  untouched samples with the new theme's. */
  catalogue: "seed-samples" | "swap-samples" | "keep";
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
    // ★ Samples and menus only into a store with nothing of its own: no
    // product, no category, no order, and no Builder header and footer. The
    // theme's menus link to its sample categories, so the two arrive together
    // or not at all, and a Builder header is the merchant's.
    const catalogue =
      facts.catalogueIsEmpty && !facts.hasBuilderChrome
        ? "seed-samples"
        : "keep";
    return {
      firstTheme: true,
      homepage,
      addMissingPages: true,
      catalogue,
      menus: catalogue === "seed-samples" ? "replace" : "keep",
      brandColor: facts.brandColorIsTheme ? "theme" : "keep",
    };
  }
  const catalogue = facts.catalogueIsSampleOnly ? "swap-samples" : "keep";
  return {
    firstTheme: false,
    homepage,
    addMissingPages: homepage !== "keep",
    catalogue,
    // ★ The menus link to the catalogue's categories. Swapping one without
    // the other leaves dead links in the header, and a Builder-edited header
    // is the merchant's.
    menus:
      catalogue === "swap-samples" && !facts.hasBuilderChrome
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
    plan.catalogue === "seed-samples"
      ? `${themeName}'s sample products and categories are added as examples. The products are drafts, so customers don't see them.`
      : plan.catalogue === "swap-samples"
        ? `The sample products and categories change to ${themeName}'s examples. The products stay drafts.`
        : first
          ? "Your products and categories are not changed, and no samples are added."
          : "Your products and categories are not changed.",
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
