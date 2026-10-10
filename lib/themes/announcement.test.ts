import { describe, expect, it } from "vitest";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { studio } from "./definitions/studio";
import {
  activeAnnouncement,
  announcementHref,
  announcementIssues,
  normalizeAnnouncement,
  withThemeAnnouncement,
} from "./announcement";

// The announcement bar (plan Phase 2c's last chrome candidate): a theme may
// ship one, a merchant owns it from the builder, and the storefront shows at
// most one line.
describe("the announcement bar", () => {
  it("links only to a site path", () => {
    expect(announcementHref("/collections/sale")).toBe("/collections/sale");
    expect(announcementHref(" /shop ")).toBe("/shop");
    expect(announcementHref("https://example.com")).toBe("");
    expect(announcementHref("//evil")).toBe("");
    expect(announcementHref("javascript:alert(1)")).toBe("");
    expect(announcementHref(42)).toBe("");
  });

  it("normalises a theme's bar and drops one with nothing to say", () => {
    expect(
      normalizeAnnouncement({ text: " Free delivery over ₹999 ", href: "" }),
    ).toEqual({ text: "Free delivery over ₹999" });
    expect(
      normalizeAnnouncement({ text: "Sale", href: "/collections/sale" }),
    ).toEqual({ text: "Sale", href: "/collections/sale" });
    expect(
      normalizeAnnouncement({ text: "  ", href: "/shop" }),
    ).toBeUndefined();
    expect(normalizeAnnouncement(null)).toBeUndefined();
    expect(normalizeAnnouncement("Sale")).toBeUndefined();
    expect(normalizeAnnouncement({ text: "x".repeat(200) })?.text).toHaveLength(
      160,
    );
  });

  it("reports what the contract would not accept as written", () => {
    expect(announcementIssues({ text: "Sale on now" })).toEqual([]);
    expect(
      announcementIssues({ text: "Sale on now", href: "/collections/sale" }),
    ).toEqual([]);
    expect(announcementIssues("Sale")).toEqual([
      "definition.preset.announcement must be an object.",
    ]);
    expect(
      announcementIssues({
        text: " padded ",
        href: "https://x",
        colour: "#fff",
      }),
    ).toEqual([
      "definition.preset.announcement.colour is not an announcement field.",
      "definition.preset.announcement.text carries surrounding whitespace.",
      'definition.preset.announcement.href must be "" or a site path starting with "/".',
    ]);
    expect(announcementIssues({ text: "", href: "" })).toEqual([
      "definition.preset.announcement.text is required.",
      "definition.preset.announcement.href is empty; omit it instead.",
    ]);
    expect(announcementIssues({ text: "x".repeat(161) })).toEqual([
      "definition.preset.announcement.text exceeds 160 characters.",
    ]);
  });

  it("carries the theme's bar onto an enabled, empty merchant bar and nowhere else", () => {
    const theme = structuredClone(studio);
    theme.preset.announcement = {
      text: "Complimentary delivery on every order",
      href: "/shop",
    };
    const inherited = withThemeAnnouncement(DEFAULT_CHROME, theme);
    expect(inherited.header.announcement).toEqual({
      enabled: true,
      text: "Complimentary delivery on every order",
      href: "/shop",
    });
    expect(activeAnnouncement(inherited)).toEqual({
      text: "Complimentary delivery on every order",
      href: "/shop",
    });
    // The input is never mutated.
    expect(DEFAULT_CHROME.header.announcement.text).toBe("");
    // Merchant text wins.
    const own = structuredClone(DEFAULT_CHROME);
    own.header.announcement.text = "Our own line";
    expect(withThemeAnnouncement(own, theme)).toBe(own);
    // A disabled bar stays disabled, and shows nothing.
    const off = structuredClone(DEFAULT_CHROME);
    off.header.announcement.enabled = false;
    expect(withThemeAnnouncement(off, theme)).toBe(off);
    expect(activeAnnouncement(off)).toBeNull();
    // A theme without one changes nothing, as does no theme.
    expect(withThemeAnnouncement(DEFAULT_CHROME, studio)).toBe(DEFAULT_CHROME);
    expect(withThemeAnnouncement(DEFAULT_CHROME, null)).toBe(DEFAULT_CHROME);
    expect(activeAnnouncement(DEFAULT_CHROME)).toBeNull();
  });
});
