import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import { digestMinkStorefrontSections } from "../storefront-layout-contract";
import {
  revampBrandDigest,
  revampChromeDigest,
  revampSectionsDigest,
} from "./digests";

/** Rebuild a JSON value with every object's keys in reverse order, the way a
 *  value read back from jsonb arrives in a different order from the one it
 *  was written in. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, reverseKeys(entry)]),
  ) as T;
}

/**
 * v1's private `brandDigestOf` (lib/mink/storefront-personalization-actions.ts),
 * copied verbatim so the equality below is checked against what v1 really
 * computes, not against this module restating itself.
 */
function v1BrandDigestOf(settings: Record<string, unknown> | null): string {
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const brand = asRecord(settings?.brand);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return digestMinkStorefrontValue({
    tagline: text(brand.tagline),
    blurb: text(brand.blurb),
  });
}

const hero: PageSectionItem = {
  id: "hero-1",
  type: "hero",
  enabled: true,
  config: {
    heading: "Cold pressed in our own mill",
    subheading: "Mustard oil from Jaipur",
    image_url: "/themes/basket/hero.webp",
    cta_label: "Shop now",
    cta_href: "/shop",
  } as never,
  style: { scheme: "soft", padding_y: "md" } as never,
};

const faq: PageSectionItem = {
  id: "faq-1",
  type: "faq_accordion",
  enabled: false,
  config: {
    heading: "Questions",
    items: [{ question: "Do you ship?", answer: "Yes", category: "" }],
  } as never,
};

describe("revampSectionsDigest", () => {
  it("★★ is the digest v1 stores and compares, for the same list", () => {
    const sections = [hero, faq];
    expect(revampSectionsDigest(sections)).toBe(
      digestMinkStorefrontSections(sections),
    );
    expect(revampSectionsDigest(sections)).toBe(
      digestMinkStorefrontValue(sections),
    );
    expect(revampSectionsDigest(sections)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("★ does not move when jsonb hands the keys back in another order", () => {
    expect(revampSectionsDigest(reverseKeys([hero, faq]))).toBe(
      revampSectionsDigest([hero, faq]),
    );
  });

  it("moves when the ORDER of the sections changes, or when one is added", () => {
    const base = revampSectionsDigest([hero, faq]);
    expect(revampSectionsDigest([faq, hero])).not.toBe(base);
    expect(revampSectionsDigest([hero])).not.toBe(base);
    expect(revampSectionsDigest([])).not.toBe(base);
  });

  it("moves when one character of one field changes", () => {
    const edited = {
      ...hero,
      config: { ...hero.config, heading: "Cold pressed in our own mill." },
    } as PageSectionItem;
    expect(revampSectionsDigest([edited, faq])).not.toBe(
      revampSectionsDigest([hero, faq]),
    );
  });
});

describe("revampChromeDigest", () => {
  it("★★ digests the WHOLE draft with the codebase's canonical hash", () => {
    expect(revampChromeDigest(DEFAULT_CHROME)).toBe(
      digestMinkStorefrontValue(DEFAULT_CHROME),
    );
  });

  it("★ is stable under key order, so a re-read row compares equal", () => {
    expect(revampChromeDigest(reverseKeys(DEFAULT_CHROME))).toBe(
      revampChromeDigest(DEFAULT_CHROME),
    );
    // A structured clone (no shared references) gives the same value too.
    expect(revampChromeDigest(structuredClone(DEFAULT_CHROME))).toBe(
      revampChromeDigest(DEFAULT_CHROME),
    );
  });

  it("★ moves when ANY part of the chrome changes, not only the copy", () => {
    const base = revampChromeDigest(DEFAULT_CHROME);
    const link: StoreChrome = {
      ...DEFAULT_CHROME,
      header: {
        ...DEFAULT_CHROME.header,
        links: [{ label: "Shop all", href: "/shop" }],
      },
    };
    const appearance: StoreChrome = {
      ...DEFAULT_CHROME,
      appearance: { ...DEFAULT_CHROME.appearance, header: "minimal" },
    };
    const footer: StoreChrome = {
      ...DEFAULT_CHROME,
      footer: { ...DEFAULT_CHROME.footer, showCredit: false },
    };
    for (const changed of [link, appearance, footer]) {
      expect(revampChromeDigest(changed)).not.toBe(base);
    }
  });
});

describe("revampBrandDigest", () => {
  const samples: Array<[string, Record<string, unknown> | null]> = [
    ["no settings at all", null],
    ["no brand key", {}],
    ["a brand that is not an object", { brand: "Lumen" }],
    ["a brand that is an array", { brand: ["Lumen"] }],
    ["an empty brand", { brand: {} }],
    [
      "both fields set",
      { brand: { tagline: "Pressed in Jaipur", blurb: "Small batch oils" } },
    ],
    [
      "whitespace around the words",
      { brand: { tagline: "  Pressed in Jaipur \n", blurb: "\tSmall batch " } },
    ],
    ["blank strings", { brand: { tagline: "   ", blurb: "" } }],
    ["non-text values", { brand: { tagline: 42, blurb: { text: "x" } } }],
    ["only a tagline", { brand: { tagline: "Pressed in Jaipur" } }],
    ["only a blurb", { brand: { blurb: "Small batch oils" } }],
    [
      "other brand keys beside them",
      {
        brand: {
          name: "Lumen",
          primaryColor: "#2542c7",
          logoUrl: "https://example.com/logo.png",
          tagline: "Pressed in Jaipur",
        },
        launched: true,
      },
    ],
  ];

  it.each(samples)(
    "★★ equals v1's brandDigestOf for %s",
    (_label, settings) => {
      expect(revampBrandDigest(settings)).toBe(v1BrandDigestOf(settings));
    },
  );

  it("★ pins the canonical encoding, so both copies cannot drift together", () => {
    // Keys sorted, nulls kept: the exact bytes the hash is taken over.
    const expected = createHash("sha256")
      .update('{"blurb":"Small batch oils","tagline":"Pressed in Jaipur"}')
      .digest("hex");
    expect(
      revampBrandDigest({
        brand: { tagline: "Pressed in Jaipur", blurb: "Small batch oils" },
      }),
    ).toBe(expected);
    const empty = createHash("sha256")
      .update('{"blurb":null,"tagline":null}')
      .digest("hex");
    expect(revampBrandDigest(null)).toBe(empty);
  });

  it("treats a blank or absent field as the same state, and other keys as irrelevant", () => {
    expect(revampBrandDigest({ brand: { tagline: "  " } })).toBe(
      revampBrandDigest({ brand: {} }),
    );
    expect(
      revampBrandDigest({ brand: { tagline: "Hi", logoUrl: "/a.png" } }),
    ).toBe(revampBrandDigest({ brand: { tagline: "Hi" } }));
    expect(revampBrandDigest({ brand: { tagline: "Hi" } })).not.toBe(
      revampBrandDigest({ brand: { blurb: "Hi" } }),
    );
  });

  it("is stable under key order", () => {
    const settings = {
      brand: { tagline: "Pressed in Jaipur", blurb: "Small batch oils" },
    };
    expect(revampBrandDigest(reverseKeys(settings))).toBe(
      revampBrandDigest(settings),
    );
  });
});
