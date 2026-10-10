// ---------------------------------------------------------------------------
// Switching a live store to another theme: WHAT is allowed to change.
//
// Pure. `lib/themes/switch.ts` reads the facts and writes the result; the
// dashboard's confirm dialog shows `describeThemeSwitch` so the merchant reads
// exactly what the server will do. Both call `planThemeSwitch`, so the dialog
// cannot promise one thing while the server does another.
//
// ★★ A THEME IS A DESIGN; THE STORE'S CONTENT IS THE MERCHANT'S. Since signup
// stopped asking for a theme (2026-10-10), every store starts on the platform
// default and its owner picks the real one here, usually within minutes, while
// everything except the design is still the old theme's starting copy. So a
// switch carries a theme's starting content with it ONLY where nothing of the
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
  /** The store has opened (settings.launched), so shoppers see changes now. */
  launched: boolean;
  homepage: "missing" | "seeded" | "edited";
  /**
   * Every product and category in the store is one of the CURRENT theme's
   * samples, and the store has never taken an order. Only then may the
   * starting catalogue be swapped for the new theme's.
   */
  catalogueIsSampleOnly: boolean;
  /** The header and footer are edited in the Website Builder (a
   *  `store_chrome` row), so the theme's menus would not show anyway. */
  hasBuilderChrome: boolean;
  /** `brand.primaryColor` is unset or still the current theme's accent. */
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
  homepage: "replace" | "backup-and-replace" | "keep";
  /** Add the theme's pages the store does not have yet. Only alongside a
   *  replaced homepage, whose links may point at them. Never overwrites. */
  addMissingPages: boolean;
  catalogue: "swap-samples" | "keep";
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
  const catalogue = facts.catalogueIsSampleOnly ? "swap-samples" : "keep";
  return {
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
  const lines = [
    `Your storefront's colours, fonts and layout change to ${themeName}.`,
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
      `${themeName}'s other starting pages are added where your store doesn't have one. Your existing pages are not changed.`,
    );
  }
  lines.push(
    plan.catalogue === "swap-samples"
      ? `The sample products and categories change to ${themeName}'s examples. The products stay drafts.`
      : "Your products and categories are not changed.",
  );
  if (plan.menus === "replace") {
    lines.push(`Your header and footer menus change to ${themeName}'s.`);
  } else if (facts.hasBuilderChrome) {
    lines.push(
      "Your header and footer stay as you set them in the Website Builder.",
    );
  }
  if (plan.brandColor === "keep") {
    lines.push("Your brand colour stays as you chose it.");
  }
  if (facts.launched) {
    lines.push("Your store is open, so shoppers see the change straight away.");
  }
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
