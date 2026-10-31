import { describe, expect, it } from "vitest";
import type { PageSectionItem } from "@/lib/sections/registry";
import { THEME_DEFINITIONS } from "./index";
import {
  chromeWithoutRemovedSamples,
  linksReachSample,
  menusWithoutRemovedSamples,
  removedSampleAddresses,
  sampleSeedsFor,
  sectionsWithoutRemovedSamples,
} from "./sample-cleanup-rules";
import { SAMPLE_LINK_FALLBACK } from "./sample-links";

const REMOVED = removedSampleAddresses({
  productSlugs: ["rowan-ankle-boot"],
  categorySlugs: ["shoes"],
});

describe("sampleSeedsFor", () => {
  it("★ carries every bundled theme's sample products and categories", () => {
    const seeds = sampleSeedsFor(THEME_DEFINITIONS);
    for (const theme of THEME_DEFINITIONS) {
      const data = theme.preset.sampleData;
      for (const p of data?.products ?? []) {
        expect(seeds.products).toContainEqual(
          expect.objectContaining({ slug: p.slug, name: p.name }),
        );
      }
      for (const c of data?.categories ?? []) {
        expect(seeds.categories).toContainEqual(
          expect.objectContaining({ slug: c.slug, name: c.name }),
        );
      }
    }
  });

  it("lists a seed once even when two releases carry it", () => {
    const theme = THEME_DEFINITIONS[0]!;
    const once = sampleSeedsFor([theme]);
    const twice = sampleSeedsFor([theme, theme]);
    expect(twice.products).toHaveLength(once.products.length);
    expect(twice.categories).toHaveLength(once.categories.length);
  });

  it("keeps each seed's description, photo and prices for the content check", () => {
    const seeds = sampleSeedsFor(THEME_DEFINITIONS);
    const product = seeds.products[0]!;
    expect(typeof product.description).toBe("string");
    expect(typeof product.imageUrl).toBe("string");
    expect(typeof product.sellingPrice).toBe("number");
    expect(typeof product.basePrice).toBe("number");
  });
});

describe("linksReachSample", () => {
  it("finds a sample link at any depth", () => {
    expect(
      linksReachSample(
        [
          { label: "Home", href: "/" },
          {
            label: "Shop",
            href: "",
            children: [{ label: "Shoes", href: "/collections/shoes" }],
          },
        ],
        REMOVED,
      ),
    ).toBe(true);
    expect(
      linksReachSample([{ label: "Story", href: "/our-story" }], REMOVED),
    ).toBe(false);
  });
});

describe("menusWithoutRemovedSamples", () => {
  it("★ changes only the part that held a removed sample's link", () => {
    const out = menusWithoutRemovedSamples(
      {
        header: [
          { label: "Home", href: "/" },
          { label: "Shoes", href: "/collections/shoes" },
        ],
        footerGroups: [],
        footerLegal: [{ label: "Terms", href: "/terms" }],
      },
      REMOVED,
    );
    expect(out).toEqual({
      // ★ Nothing left in the header leads into the catalogue, so a link to
      // the shop goes first.
      header: [
        { label: "Shop", href: SAMPLE_LINK_FALLBACK },
        { label: "Home", href: "/" },
      ],
      // ★ A footer the merchant left empty stays empty: it held no sample link.
      footerGroups: [],
      footerLegal: [{ label: "Terms", href: "/terms" }],
    });
  });

  it("adds no shop link when the header still leads into the catalogue", () => {
    const out = menusWithoutRemovedSamples(
      {
        header: [
          { label: "Shoes", href: "/collections/shoes" },
          {
            label: "More",
            href: "",
            children: [{ label: "Bags", href: "/collections/bags" }],
          },
        ],
        footerGroups: [],
        footerLegal: [],
      },
      REMOVED,
    );
    expect(out?.header).toEqual([
      {
        label: "More",
        href: "",
        children: [{ label: "Bags", href: "/collections/bags" }],
      },
    ]);
  });

  it("gives a header left with nothing one link to the shop", () => {
    const out = menusWithoutRemovedSamples(
      {
        header: [{ label: "Shoes", href: "/collections/shoes" }],
        footerGroups: [],
        footerLegal: [],
      },
      REMOVED,
    );
    expect(out?.header).toEqual([
      { label: "Shop", href: SAMPLE_LINK_FALLBACK },
    ]);
  });

  it("answers null when no link reached a removed sample", () => {
    expect(
      menusWithoutRemovedSamples(
        {
          header: [{ label: "Shop", href: "/shop" }],
          footerGroups: [],
          footerLegal: [],
        },
        REMOVED,
      ),
    ).toBeNull();
  });

  it("★ never touches a link to a sample that was kept (the merchant's own)", () => {
    // "bags" is a theme sample this store edited, so it was not removed.
    expect(
      menusWithoutRemovedSamples(
        {
          header: [{ label: "Bags", href: "/collections/bags" }],
          footerGroups: [],
          footerLegal: [],
        },
        REMOVED,
      ),
    ).toBeNull();
  });

  it("answers null when nothing was removed", () => {
    expect(
      menusWithoutRemovedSamples(
        {
          header: [{ label: "Shoes", href: "/collections/shoes" }],
          footerGroups: [],
          footerLegal: [],
        },
        removedSampleAddresses({ productSlugs: [], categorySlugs: [] }),
      ),
    ).toBeNull();
  });
});

describe("chromeWithoutRemovedSamples", () => {
  const chrome = {
    header: {
      links: [
        { label: "Home", href: "/" },
        { label: "Boot", href: "/shop/rowan-ankle-boot" },
      ],
      showSearch: true,
      announcement: {
        enabled: true,
        text: "New boots",
        href: "/shop/rowan-ankle-boot",
      },
    },
    footer: {
      groups: [
        {
          title: "Shop",
          links: [
            { label: "Shoes", href: "/collections/shoes" },
            { label: "All", href: "/shop" },
          ],
        },
      ],
      legal: [{ label: "Terms", href: "/terms" }],
      showNewsletter: false,
    },
    design: { palette: { accent: "#000000" } },
  };

  it("★ takes the links out and keeps every other setting exactly", () => {
    const out = chromeWithoutRemovedSamples(chrome, REMOVED);
    expect(out).toEqual({
      header: {
        links: [
          { label: "Shop", href: SAMPLE_LINK_FALLBACK },
          { label: "Home", href: "/" },
        ],
        showSearch: true,
        announcement: {
          enabled: true,
          text: "New boots",
          href: SAMPLE_LINK_FALLBACK,
        },
      },
      footer: {
        groups: [{ title: "Shop", links: [{ label: "All", href: "/shop" }] }],
        legal: [{ label: "Terms", href: "/terms" }],
        showNewsletter: false,
      },
      design: { palette: { accent: "#000000" } },
    });
  });

  it("answers null for chrome with no link to a removed sample", () => {
    expect(
      chromeWithoutRemovedSamples(
        { header: { links: [{ label: "Home", href: "/" }] }, footer: {} },
        REMOVED,
      ),
    ).toBeNull();
  });

  it("answers null for a value that is not chrome", () => {
    expect(chromeWithoutRemovedSamples(null, REMOVED)).toBeNull();
    expect(chromeWithoutRemovedSamples([], REMOVED)).toBeNull();
  });
});

describe("sectionsWithoutRemovedSamples", () => {
  const sections = [
    {
      id: "s1",
      type: "hero",
      enabled: true,
      config: { heading: "New in", cta_href: "/collections/shoes" },
    },
    {
      id: "s2",
      type: "rich_text",
      enabled: true,
      config: { html: "<p>Hello</p>" },
    },
  ] as unknown as PageSectionItem[];

  it("sends a button at a removed sample to the shop", () => {
    const out = sectionsWithoutRemovedSamples(sections, REMOVED);
    expect(out?.[0]?.config).toEqual({
      heading: "New in",
      cta_href: SAMPLE_LINK_FALLBACK,
    });
    expect(out?.[1]).toEqual(sections[1]);
  });

  it("answers null when no section changed", () => {
    expect(sectionsWithoutRemovedSamples([sections[1]!], REMOVED)).toBeNull();
  });

  it("answers null for stored sections that are not a list", () => {
    expect(sectionsWithoutRemovedSamples(null, REMOVED)).toBeNull();
    expect(sectionsWithoutRemovedSamples({}, REMOVED)).toBeNull();
  });
});
