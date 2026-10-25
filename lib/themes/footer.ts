import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";
import type { ThemeDefinition } from "./types";
import type { NewsletterSectionConfig } from "@/lib/homepage/section-types";
import {
  normalizeAnnouncement,
  withAnnouncementLine,
  type ThemeAnnouncement,
} from "./announcement";

/** The theme's newsletter words, from its homepage's newsletter section. */
export interface ThemeNewsletterCopy {
  heading: string;
  subheading: string;
  buttonLabel: string;
  consentText: string;
}

/** The pinned theme's homepage newsletter voice, or null when it has none. */
export function themeNewsletterCopy(
  theme: ThemeDefinition | null,
): ThemeNewsletterCopy | null {
  const section = theme?.preset.pages
    .find((p) => p.slug === "")
    ?.sections.find((s) => s.enabled && s.type === "newsletter");
  if (!section || section.type !== "newsletter") return null;
  const config = section.config as NewsletterSectionConfig;
  if (!config.heading.trim()) return null;
  return {
    heading: config.heading,
    subheading: config.subheading ?? "",
    buttonLabel: config.button_label ?? "",
    consentText: config.consent_text ?? "",
  };
}

/** One field of copy handed over the wire: text, or nothing. */
const words = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Carry a theme's newsletter voice onto commerce pages when the store still
 * has platform-default footer copy. Merchant-written copy wins; a toggle is
 * never changed. ★ A chrome with no newsletter block (one a preview frame was
 * sent by an older sender) is left as it is.
 */
export function withNewsletterCopy(
  chrome: StoreChrome,
  copy: ThemeNewsletterCopy | null | undefined,
): StoreChrome {
  const current = chrome.footer?.newsletter;
  if (!current || !copy) return chrome;
  const defaults = DEFAULT_CHROME.footer.newsletter;
  const keys = ["heading", "subtext", "buttonLabel", "consentText"] as const;
  if (!keys.every((key) => current[key] === defaults[key])) return chrome;
  const heading = words(copy.heading);
  if (!heading.trim()) return chrome;
  return {
    ...chrome,
    footer: {
      ...chrome.footer,
      newsletter: {
        ...current,
        heading,
        subtext: words(copy.subheading) || current.subtext,
        buttonLabel: words(copy.buttonLabel) || current.buttonLabel,
        consentText: words(copy.consentText) || current.consentText,
      },
    },
  };
}

/** `withNewsletterCopy` with the pinned theme's own words. */
export function withThemeNewsletter(
  chrome: StoreChrome,
  theme: ThemeDefinition | null,
): StoreChrome {
  return withNewsletterCopy(chrome, themeNewsletterCopy(theme));
}

/**
 * ★★ What the pinned theme lays over a store's own header and footer: its
 *   announcement bar and its newsletter words. Read from the theme once, on
 *   the server, and applied by ONE function, `withThemeChromeDefaults`: the
 *   storefront layout runs it over the chrome it renders, and ChromeProvider
 *   over chrome a preview frame is sent (the Website Builder's edit, the
 *   redesign's proposal), so the frame shows exactly what the live store
 *   would show from that chrome. A few lines of text, so the layout can hand
 *   it to a client component where the whole theme could never go.
 */
export interface ThemeChromeDefaults {
  announcement: ThemeAnnouncement | null;
  newsletter: ThemeNewsletterCopy | null;
}

export function themeChromeDefaults(
  theme: ThemeDefinition | null,
): ThemeChromeDefaults {
  return {
    announcement: normalizeAnnouncement(theme?.preset.announcement) ?? null,
    newsletter: themeNewsletterCopy(theme),
  };
}

export function withThemeChromeDefaults(
  chrome: StoreChrome,
  defaults: ThemeChromeDefaults | null | undefined,
): StoreChrome {
  if (!defaults) return chrome;
  return withAnnouncementLine(
    withNewsletterCopy(chrome, defaults.newsletter),
    defaults.announcement,
  );
}
