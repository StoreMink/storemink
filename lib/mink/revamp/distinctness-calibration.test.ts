// The same-theme bar, re-measured on every run (robustness audit of
// 23 Oct 2026, section 5: revamp-handoff/scratchpad/uniqueness-ref/
// fingerprints.json). The three plans below are the audit's stored plans
// (crumb-and-co runs 2 and 3 on Basket, neem-ritual run 3 on Ritual, both
// made-up shops of scripts/revamp-live-fixtures.ts) cut down to their design
// choices: no words, links, products or photos.
import { describe, expect, it } from "vitest";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  DISTINCTNESS_THRESHOLD,
  fingerprintDistance,
  themeFingerprint,
} from "@/lib/theme-studio/fingerprint";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { basket } from "@/lib/themes/definitions/basket";
import { ritual } from "@/lib/themes/definitions/ritual";
import type { ThemeDefinition } from "@/lib/themes/types";
import type { RevampSitePlan } from "./contract";
import {
  fingerprintFieldShares,
  revampDistinctnessBar,
  revampFingerprint,
  revampThemeFixedFields,
  revampThemeFixedShare,
} from "./distinctness";

type Raw = Record<string, unknown>;

function home(sections: Array<[string, Raw, Raw]>): RevampSitePlan["pages"] {
  return [
    {
      slug: "",
      title: "Home",
      seoTitle: "",
      seoDescription: "",
      create: false,
      pageId: null,
      sections: sections.map(
        ([type, style, config], i) =>
          ({
            id: `s${i}`,
            type,
            enabled: true,
            style,
            config,
          }) as unknown as PageSectionItem,
      ),
    },
  ];
}

function plan(
  direction: string,
  design: Raw,
  appearance: Raw,
  sections: Array<[string, Raw, Raw]>,
): RevampSitePlan {
  return {
    direction,
    design,
    appearance,
    pages: home(sections),
  } as unknown as RevampSitePlan;
}

const CRUMB_R2 = plan(
  "soft-and-natural",
  {
    fonts: { body: "nunito", display: "lora" },
    shape: { sm: 4, card: 12, pill: 999, control: 8 },
    palette: {
      ink: "#2b2118",
      cream: "#faf6ee",
      accent: "#d65c2b",
      border: "#e5d9cb",
      inkSoft: "#5c4e43",
      surface: "#ffffff",
      inkFaint: "#9c8c80",
      creamDeep: "#f0e7d8",
    },
  },
  {
    card: "quick_add",
    footer: "rich",
    header: "classic",
    productDetail: "classic",
  },
  [
    ["hero_carousel", { width: "full" }, { height: "large" }],
    [
      "usp_bar",
      { width: "contained", scheme: "soft", padding_y: "sm" },
      { theme: "light" },
    ],
    [
      "shop_by_category",
      { width: "contained", padding_y: "md" },
      { layout: "scroll", display: "circles" },
    ],
    ["featured_products", { width: "contained", padding_y: "md" }, {}],
    [
      "multicolumn",
      { width: "contained", scheme: "tint", padding_y: "lg" },
      { alignment: "center" },
    ],
    [
      "media_text",
      { width: "contained", padding_y: "md" },
      { media_position: "left", media_ratio: "portrait" },
    ],
    [
      "newsletter",
      { width: "contained", scheme: "soft", padding_y: "md" },
      { theme: "light", alignment: "center" },
    ],
  ],
);

const CRUMB_R3 = plan(
  "soft-and-natural",
  {
    fonts: { body: "nunito", display: "lora" },
    shape: { sm: 6, card: 12, pill: 999, control: 8 },
    palette: {
      ink: "#291f19",
      cream: "#faf6f0",
      accent: "#d95f36",
      border: "#e8dfd3",
      inkSoft: "#66554b",
      surface: "#ffffff",
      inkFaint: "#9c8c82",
      creamDeep: "#f2ebe0",
    },
  },
  {
    card: "quick_add",
    footer: "rich",
    header: "market",
    productDetail: "grocery",
  },
  [
    ["hero_carousel", { width: "full" }, { height: "large" }],
    [
      "usp_bar",
      { width: "contained", scheme: "soft", padding_y: "sm" },
      { theme: "light" },
    ],
    [
      "shop_by_category",
      { width: "contained", padding_y: "md" },
      { layout: "scroll", display: "circles" },
    ],
    ["featured_products", { width: "contained", padding_y: "md" }, {}],
    [
      "media_text",
      { width: "contained", scheme: "tint", padding_y: "lg" },
      {
        media_position: "left",
        media_ratio: "portrait",
        stories: [{ media_position: "right" }],
      },
    ],
    [
      "newsletter",
      { width: "full", scheme: "inverse", padding_y: "lg" },
      { theme: "dark", alignment: "center" },
    ],
  ],
);

const NEEM_R3 = plan(
  "soft-and-natural",
  {
    fonts: { body: "inter", display: "fraunces" },
    shape: { sm: 4, card: 12, pill: 999, control: 8 },
    palette: {
      ink: "#1e2922",
      cream: "#f4f6f0",
      accent: "#2d523e",
      border: "#d5ded3",
      inkSoft: "#435247",
      surface: "#ffffff",
      inkFaint: "#7c8c80",
      creamDeep: "#e7ebe1",
    },
  },
  {
    card: "framed",
    footer: "minimal",
    header: "minimal",
    productDetail: "editorial",
  },
  [
    ["hero_carousel", { width: "full" }, { height: "large" }],
    [
      "usp_bar",
      { width: "contained", scheme: "soft", padding_y: "sm" },
      { theme: "light" },
    ],
    ["featured_products", { width: "contained", padding_y: "md" }, {}],
    [
      "media_text",
      { width: "contained", scheme: "tint", padding_y: "lg" },
      {
        media_position: "left",
        media_ratio: "portrait",
        stories: [{ media_position: "right" }],
      },
    ],
    [
      "gallery",
      { width: "contained", padding_y: "md" },
      { layout: "editorial" },
    ],
    [
      "newsletter",
      { width: "full", scheme: "accent", padding_y: "lg" },
      { theme: "dark", alignment: "center" },
    ],
  ],
);

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const distance = (
  a: [ThemeDefinition, RevampSitePlan | Raw],
  b: [ThemeDefinition, RevampSitePlan | Raw],
) =>
  round3(
    fingerprintDistance(
      revampFingerprint(a[0], a[1] as RevampSitePlan),
      revampFingerprint(b[0], b[1] as RevampSitePlan),
    ),
  );

describe("the fingerprint's weights, read from Theme Studio's own distance", () => {
  it("gives every field its share, and the shares make the whole", () => {
    const shares = fingerprintFieldShares(revampFingerprint(basket, {}));
    const points = Object.fromEntries(
      Object.entries(shares).map(([field, share]) => [
        field,
        Math.round(share * 104 * 1000) / 1000,
      ]),
    );
    expect(points).toEqual({
      composition: 10,
      card: 10,
      hero: 10,
      sections: 12,
      sectionStyles: 6,
      pageColour: 12,
      accentHue: 4,
      bodyFont: 5,
      displayFont: 8,
      buttons: 5,
      width: 4,
      grid: 4,
      shape: 3,
      heading: 4,
      motion: 1,
      category: 3,
      newsletter: 3,
    });
    const total = Object.values(shares).reduce((sum, share) => sum + share, 0);
    expect(total).toBeCloseTo(1, 12);
  });
});

describe("★ the share each bundled theme fixes, and the bar", () => {
  it.each(THEME_DEFINITIONS.map((theme) => [theme.id, theme] as const))(
    "%s fixes buttons, headings, page width, grid and motion: 18 of 104, bar 0.289",
    (_id, theme) => {
      expect([...revampThemeFixedFields(theme)].sort()).toEqual([
        "buttons",
        "grid",
        "heading",
        "motion",
        "width",
      ]);
      expect(revampThemeFixedShare(theme)).toBeCloseTo(18 / 104, 12);
      expect(revampDistinctnessBar(theme)).toBe(0.289);
    },
  );

  it("is Theme Studio's threshold times what the theme leaves reachable", () => {
    for (const theme of THEME_DEFINITIONS) {
      expect(revampDistinctnessBar(theme)).toBe(
        round3(DISTINCTNESS_THRESHOLD * (1 - revampThemeFixedShare(theme))),
      );
      // Calibrated, not copied: lower than Theme Studio's bar between themes.
      expect(revampDistinctnessBar(theme)).toBeLessThan(DISTINCTNESS_THRESHOLD);
    }
  });

  it("every field a plan sets moves on every bundled theme (none is read as fixed)", () => {
    for (const theme of THEME_DEFINITIONS) {
      const fixed = revampThemeFixedFields(theme);
      for (const field of [
        "composition",
        "card",
        "hero",
        "sections",
        "sectionStyles",
        "pageColour",
        "accentHue",
        "bodyFont",
        "displayFont",
        "shape",
        "category",
        "newsletter",
      ]) {
        expect(fixed).not.toContain(field);
      }
    }
  });
});

describe("★ the audit's measured pairs", () => {
  it("the same bakery planned twice on Basket is 0.166 apart: below the bar", () => {
    const d = distance([basket, CRUMB_R2], [basket, CRUMB_R3]);
    expect(d).toBe(0.166);
    expect(d).toBeLessThan(revampDistinctnessBar(basket));
    // 13 of 17 fields the same, as the audit counted them.
    const a = revampFingerprint(basket, CRUMB_R2);
    const b = revampFingerprint(basket, CRUMB_R3);
    const shared = (Object.keys(a) as Array<keyof typeof a>).filter(
      (field) => JSON.stringify(a[field]) === JSON.stringify(b[field]),
    );
    expect(shared.sort()).toEqual(
      [
        "card",
        "hero",
        "pageColour",
        "accentHue",
        "bodyFont",
        "displayFont",
        "buttons",
        "width",
        "grid",
        "shape",
        "heading",
        "motion",
        "category",
      ].sort(),
    );
  });

  it("the bakery on Basket and the skincare shop on Ritual are 0.452 apart: above it", () => {
    const d = distance([basket, CRUMB_R3], [ritual, NEEM_R3]);
    expect(d).toBe(0.452);
    expect(d).toBeGreaterThanOrEqual(revampDistinctnessBar(basket));
    expect(d).toBeGreaterThanOrEqual(revampDistinctnessBar(ritual));
    // Two themes: Theme Studio's own bar holds too.
    expect(d).toBeGreaterThanOrEqual(DISTINCTNESS_THRESHOLD);
  });

  it("the rest of the audit's matrix", () => {
    expect(distance([basket, CRUMB_R2], [ritual, NEEM_R3])).toBe(0.496);
    expect(distance([basket, {}], [ritual, {}])).toBe(0.611);
    expect(distance([ritual, NEEM_R3], [ritual, {}])).toBe(0.394);
  });
});

describe("★ why Basket's share is 17.3%, not the audit's 27%", () => {
  it("shoppers see the plan's card on Basket, and the fingerprint does too", () => {
    expect(revampFingerprint(basket, {}).card).toBe("grocery");
    // crumb chose quick add: shoppers saw classic cards with a quick add.
    expect(revampFingerprint(basket, CRUMB_R3).card).toBe("quick_add");
    expect(
      revampFingerprint(basket, { ...CRUMB_R3, appearance: { card: "framed" } })
        .card,
    ).toBe("framed");
    // The two runs differ from the bare theme by the card as well.
    expect(distance([basket, CRUMB_R3], [basket, {}])).toBe(0.49);
  });

  it("the audit's mapping kept Basket's grocery shorthand, which reads every card as grocery", () => {
    const layout = basket.preset.design.layout ?? {};
    const audit = themeFingerprint({
      ...basket,
      preset: {
        ...basket.preset,
        design: {
          ...basket.preset.design,
          layout: { ...layout, card: "framed" },
        },
      },
    });
    expect(layout.storefront).toBe("grocery");
    expect(audit.card).toBe("grocery");
    // Counted as fixed, the card's 10 points make 28 of 104: a bar of 0.256.
    // Both readings put 0.166 below the bar and 0.452 above it.
    const auditBar = round3(DISTINCTNESS_THRESHOLD * (1 - 28 / 104));
    expect(auditBar).toBe(0.256);
    expect(0.166).toBeLessThan(auditBar);
    expect(0.452).toBeGreaterThan(revampDistinctnessBar(basket));
  });
});
