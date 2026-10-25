import { describe, expect, it } from "vitest";
import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";
import { studio } from "./definitions/studio";
import { withThemeAnnouncement } from "./announcement";
import {
  themeChromeDefaults,
  withThemeChromeDefaults,
  withThemeNewsletter,
} from "./footer";
import type { NewsletterSectionConfig } from "@/lib/homepage/section-types";

it("shares the homepage newsletter voice with default commerce footers without changing toggles", () => {
  const theme = structuredClone(studio);
  const section = theme.preset.pages
    .find((p) => p.slug === "")!
    .sections.find((s) => s.type === "newsletter")!;
  if (section.type !== "newsletter") throw new Error("fixture");
  const config = section.config as NewsletterSectionConfig;
  config.heading = "The Atelier Dispatch";
  config.subheading = "Private collection previews.";
  const chrome = structuredClone(DEFAULT_CHROME);
  chrome.footer.newsletter.enabled = false;
  const next = withThemeNewsletter(chrome, theme);
  expect(next.footer.newsletter.heading).toBe("The Atelier Dispatch");
  expect(next.footer.newsletter.subtext).toBe("Private collection previews.");
  expect(next.footer.newsletter.enabled).toBe(false);
  expect(chrome.footer.newsletter.heading).toBe("Stay in the loop");
});

it("preserves merchant copy and themes without a newsletter", () => {
  const chrome = structuredClone(DEFAULT_CHROME);
  chrome.footer.newsletter.heading = "Our subscriber club";
  expect(withThemeNewsletter(chrome, studio)).toBe(chrome);
  expect(withThemeNewsletter(DEFAULT_CHROME, null)).toBe(DEFAULT_CHROME);
});

// ★★ P-1 (2026-10-22): the layout and a preview frame lay the theme's bar and
// newsletter words over chrome with ONE function, from defaults read once.
describe("the theme's chrome defaults", () => {
  function themed() {
    const theme = structuredClone(studio);
    theme.preset.announcement = {
      text: "Complimentary delivery on every order",
      href: "/shop",
    };
    return theme;
  }

  it("are read once from the theme, small enough to hand a client component", () => {
    const defaults = themeChromeDefaults(themed());
    expect(defaults.announcement).toEqual({
      text: "Complimentary delivery on every order",
      href: "/shop",
    });
    expect(defaults.newsletter?.heading).toBeTruthy();
    expect(JSON.parse(JSON.stringify(defaults))).toEqual(defaults);
    expect(themeChromeDefaults(null)).toEqual({
      announcement: null,
      newsletter: null,
    });
  });

  it("lay over chrome exactly as the two theme merges always did, and survive the wire", () => {
    const theme = themed();
    const defaults = themeChromeDefaults(theme);
    const own = structuredClone(DEFAULT_CHROME);
    own.header.announcement.text = "Our own line";
    own.footer.newsletter.heading = "Our subscriber club";
    const off = structuredClone(DEFAULT_CHROME);
    off.header.announcement.enabled = false;
    for (const chrome of [DEFAULT_CHROME, own, off]) {
      const before = structuredClone(chrome);
      const expected = withThemeAnnouncement(
        withThemeNewsletter(chrome, theme),
        theme,
      );
      expect(withThemeChromeDefaults(chrome, defaults)).toEqual(expected);
      // A frame receives the defaults as JSON.
      expect(
        withThemeChromeDefaults(chrome, JSON.parse(JSON.stringify(defaults))),
      ).toEqual(expected);
      expect(chrome).toEqual(before);
    }
    // A store whose chrome is all its own, or no defaults, changes nothing.
    expect(withThemeChromeDefaults(own, defaults)).toBe(own);
    expect(withThemeChromeDefaults(DEFAULT_CHROME, undefined)).toBe(
      DEFAULT_CHROME,
    );
    expect(withThemeChromeDefaults(DEFAULT_CHROME, null)).toBe(DEFAULT_CHROME);
  });

  it("leave a sent chrome without a bar or a newsletter block as it is", () => {
    const defaults = themeChromeDefaults(themed());
    const partial = {
      ...DEFAULT_CHROME,
      header: { ...DEFAULT_CHROME.header, announcement: undefined },
      footer: { ...DEFAULT_CHROME.footer, newsletter: undefined },
    } as unknown as StoreChrome;
    expect(withThemeChromeDefaults(partial, defaults)).toBe(partial);
  });

  it("read a line handed over the wire with the storefront's own rule", () => {
    const merged = withThemeChromeDefaults(DEFAULT_CHROME, {
      announcement: {
        text: "  Free delivery  ",
        href: "https://elsewhere.example",
      },
      newsletter: {
        heading: "Notes",
        subheading: 42 as unknown as string,
        buttonLabel: "",
        consentText: "",
      },
    });
    expect(merged.header.announcement).toEqual({
      enabled: true,
      text: "Free delivery",
      href: "",
    });
    expect(merged.footer.newsletter.heading).toBe("Notes");
    // A field that is not text keeps the platform's words.
    expect(merged.footer.newsletter.subtext).toBe(
      DEFAULT_CHROME.footer.newsletter.subtext,
    );
  });
});
