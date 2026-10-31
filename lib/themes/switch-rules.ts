// ---------------------------------------------------------------------------
// Installing a store's theme: WHAT is allowed to change.
//
// Pure. `lib/themes/switch.ts` reads the facts and writes the result; the
// dashboard's confirm dialog shows `describeThemeSwitch` so the merchant reads
// exactly what the server will do. Both call `planThemeSwitch`, so the dialog
// cannot promise one thing while the server does another.
//
// ★★ A THEME IS CHOSEN ONCE (owner, 31 Oct 2026). Since 2026-10-11 signup
// installs no theme (settings.themePending), and the owner's one choice on
// Dashboard → Storefront installs it. A store that already has a theme keeps
// it: switch.ts refuses it before these rules are asked, and the plan for a
// switch between themes was deleted (owner, 31 Oct 2026). Stores made before
// themePending started on the platform default and keep it.
//
// ★★ A THEME IS A DESIGN; THE STORE'S CONTENT IS THE MERCHANT'S. An install
// fills an empty start without losing anything the merchant already made:
//
//   • the design (colours, fonts, layout) always arrives;
//   • the homepage is created unless the merchant already built one, and a
//     built one is replaced only on request, after it is kept as a draft page;
//   • the theme's other pages fill only free slugs (policies written in
//     Settings → Policies live at those slugs and stay);
//   • ★★ NO SAMPLE CATALOGUE EVER ARRIVES (owner, 31 Oct 2026: the theme's
//     sample products and categories "should not be visible anywhere in the
//     dashboard at all"). Stores that installed a theme before this were
//     cleaned up by scripts/remove-theme-samples.ts (lib/themes/sample-cleanup.ts);
//   • the theme's menus arrive without their links to its sample catalogue
//     (lib/themes/sample-links.ts), and never over a header and footer edited
//     in the Website Builder;
//   • the brand colour follows the theme only while the merchant has not set
//     one.
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
 * (`settings.theme.homepageSeededAt`, written by every seed, by the install
 * that writes the homepage, and by the sample clean-up when it takes a sample
 * link out of a homepage still in the theme's words), otherwise the row's
 * creation time, which is the signup seed for a store created before the
 * record existed.
 *
 * ★ Without the record, a later rewrite of the theme's own homepage would
 * leave `updated_at` far from `created_at`, and the next read would call it
 * "edited": the go-live checklist would tick "Personalise your homepage" for
 * the merchant.
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
   * this is its one install, and the storefront shows a "store in progress"
   * page until it lands. Only such a store may install a theme.
   */
  firstTheme: boolean;
  /** The store has opened (settings.launched), so shoppers see changes now. */
  launched: boolean;
  /**
   * No theme ever wrote the homepage, so a row with any sections is the
   * merchant's ("edited") and an empty one, such as the blank draft the
   * Website Builder opens, counts as "missing".
   */
  homepage: "missing" | "edited";
  /** The header and footer are edited in the Website Builder (a
   *  `store_chrome` row), so the theme's menus would not show anyway. */
  hasBuilderChrome: boolean;
  /** `brand.primaryColor` is unset, so the theme's accent may fill it. */
  brandColorUnset: boolean;
  /** Colours, fonts or layout chosen in the Website Builder, which stay on
   *  top of any theme. Said in the dialog, never cleared by an install. */
  hasDesignOverrides: boolean;
}

export interface ThemeSwitchOptions {
  /** The merchant asked for a homepage they built to be replaced too. */
  replaceEditedHomepage: boolean;
}

/**
 * What an install changes beyond the design, which always arrives along with
 * the end of settings.themePending. The theme's missing pages are always
 * added, only at free slugs, and no plan adds samples.
 */
export interface ThemeSwitchPlan {
  homepage: "replace" | "backup-and-replace" | "keep";
  menus: "replace" | "keep";
  brandColor: "theme" | "keep";
}

export function planThemeSwitch(
  facts: ThemeSwitchFacts,
  options: ThemeSwitchOptions,
): ThemeSwitchPlan {
  return {
    homepage:
      facts.homepage === "edited"
        ? options.replaceEditedHomepage
          ? "backup-and-replace"
          : "keep"
        : "replace",
    // ★ The theme's menus arrive without their links to its sample
    // catalogue, so they need no catalogue to be right; only a Builder
    // header and footer, which are the merchant's, keep them out.
    menus: facts.hasBuilderChrome ? "keep" : "replace",
    brandColor: facts.brandColorUnset ? "theme" : "keep",
  };
}

/**
 * The confirm dialog's account of an install, one sentence per thing that
 * changes or deliberately does not. Built from the same plan the server runs.
 */
export function describeThemeSwitch(
  themeName: string,
  facts: ThemeSwitchFacts,
  plan: ThemeSwitchPlan,
): string[] {
  const lines = [
    `Your storefront gets ${themeName}'s colours, fonts and layout, and stops showing the store-in-progress page.`,
  ];
  if (facts.hasDesignOverrides) {
    lines.push(
      "Colours, fonts and layouts you chose in the Website Builder stay as they are. Reset them there to use the theme's.",
    );
  }
  if (plan.homepage === "replace") {
    lines.push(`Your homepage is created from ${themeName}'s starting design.`);
  } else if (plan.homepage === "backup-and-replace") {
    lines.push(
      `Your edited homepage is saved as a draft page called "Homepage before ${themeName}", then replaced with ${themeName}'s.`,
    );
  } else {
    lines.push(
      "Your homepage keeps its sections and their new look. Redesign it any time in the Website Builder.",
    );
  }
  lines.push(
    `${themeName}'s starting pages are added where your store doesn't have a page yet. Pages you've already written, like your policies, are not changed.`,
    "No sample products or categories are added, so your dashboard shows only what you add.",
  );
  if (plan.menus === "replace") {
    lines.push(`Your header and footer menus are set up from ${themeName}'s.`);
  } else if (facts.hasBuilderChrome) {
    lines.push(
      "Your header and footer stay as you set them in the Website Builder.",
    );
  }
  lines.push(
    plan.brandColor === "keep"
      ? "Your brand colour stays as you chose it."
      : `Your brand colour starts as ${themeName}'s. You can change it any time.`,
  );
  if (facts.launched) {
    lines.push("Your store is open, so shoppers see the change straight away.");
  }
  lines.push(
    "You can't switch to another theme later, but you can change how your store looks any time with Customise storefront and the Website Builder.",
  );
  return lines;
}

/**
 * The slug of the draft page that keeps an edited homepage before an install
 * replaces it. Unique per install, and a valid custom-page slug (lower-case
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
