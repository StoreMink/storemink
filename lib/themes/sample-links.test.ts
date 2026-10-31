import { describe, expect, it } from "vitest";
import type { StoreMenus } from "@/lib/menus";
import type { PageSectionItem } from "@/lib/sections/registry";
import { THEME_DEFINITIONS } from "./index";
import {
  isSampleLink,
  menusWithoutSampleLinks,
  SAMPLE_LINK_FALLBACK,
  sampleAddresses,
  sectionsWithoutSampleLinks,
  type SampleAddresses,
} from "./sample-links";

const ADDRESSES: SampleAddresses = {
  categories: new Set(["shoes", "bags"]),
  products: new Set(["rowan-ankle-boot"]),
};

describe("isSampleLink", () => {
  it.each([
    "/collections/shoes",
    "/collections/bags?sort=new",
    "/shop?category=shoes",
    "/shop?sort=price&category=bags",
    "/shop/rowan-ankle-boot",
    "/shop/rowan-ankle-boot#reviews",
    " /collections/shoes ",
  ])("%s points at a sample", (href) => {
    expect(isSampleLink(href, ADDRESSES)).toBe(true);
  });

  it.each([
    "/shop",
    "/shop?category=sale",
    "/collections/sale",
    "/collections",
    "/shop/someone-elses-boot",
    "/our-story",
    "",
    "https://example.com/collections/shoes",
    "//evil.example/collections/shoes",
    "/collections/shoes/extra",
  ])("%s does not", (href) => {
    expect(isSampleLink(href, ADDRESSES)).toBe(false);
  });
});

describe("menusWithoutSampleLinks", () => {
  it("★ takes sample links out and keeps a heading while it still has links under it", () => {
    const menus: StoreMenus = {
      header: [
        { label: "Home", href: "/" },
        {
          label: "Shop",
          href: "/collections/shoes",
          image_url: "/themes/vitrine/menu.webp",
          children: [
            { label: "Shoes", href: "/collections/shoes" },
            { label: "Everything", href: "/shop" },
          ],
        },
        { label: "Boot", href: "/shop/rowan-ankle-boot" },
      ],
      footerGroups: [
        {
          title: "Shop",
          links: [
            { label: "Bags", href: "/collections/bags" },
            { label: "All", href: "/shop" },
          ],
        },
        {
          title: "Picks",
          links: [{ label: "Boot", href: "/shop/rowan-ankle-boot" }],
        },
      ],
      footerLegal: [
        { label: "Terms", href: "/terms" },
        { label: "Bags", href: "/collections/bags" },
      ],
    };
    expect(menusWithoutSampleLinks(menus, ADDRESSES)).toEqual({
      header: [
        { label: "Home", href: "/" },
        {
          label: "Shop",
          href: "",
          image_url: "/themes/vitrine/menu.webp",
          children: [{ label: "Everything", href: "/shop" }],
        },
      ],
      footerGroups: [
        { title: "Shop", links: [{ label: "All", href: "/shop" }] },
      ],
      footerLegal: [{ label: "Terms", href: "/terms" }],
    });
  });

  it("★ a menu left with nothing still leads to the shop, never to a fallback with dead links", () => {
    const menus: StoreMenus = {
      header: [{ label: "Shoes", href: "/collections/shoes" }],
      footerGroups: [
        {
          title: "Shop",
          links: [{ label: "Bags", href: "/collections/bags" }],
        },
      ],
      footerLegal: [],
    };
    expect(menusWithoutSampleLinks(menus, ADDRESSES)).toEqual({
      header: [{ label: "Shop", href: SAMPLE_LINK_FALLBACK }],
      footerGroups: [
        {
          title: "Shop",
          links: [{ label: "All products", href: SAMPLE_LINK_FALLBACK }],
        },
      ],
      footerLegal: [],
    });
  });
});

describe("sectionsWithoutSampleLinks", () => {
  it("sends a button or tile at a sample to the shop and changes nothing else", () => {
    const sections = [
      {
        id: "s1",
        type: "hero",
        enabled: true,
        config: {
          heading: "New in",
          cta_href: "/collections/shoes",
          secondary_href: "/our-story",
        },
      },
      {
        id: "s2",
        type: "tile_grid",
        enabled: true,
        config: {
          items: [
            { title: "Boot", href: "/shop/rowan-ankle-boot" },
            { title: "Story", href: "/our-story" },
          ],
        },
      },
    ] as unknown as PageSectionItem[];
    const out = sectionsWithoutSampleLinks(sections, ADDRESSES);
    expect(out[0]!.config).toEqual({
      heading: "New in",
      cta_href: SAMPLE_LINK_FALLBACK,
      secondary_href: "/our-story",
    });
    expect(out[1]!.config).toEqual({
      items: [
        { title: "Boot", href: SAMPLE_LINK_FALLBACK },
        { title: "Story", href: "/our-story" },
      ],
    });
    // The input is not changed.
    expect(
      (sections[0]!.config as unknown as Record<string, unknown>).cta_href,
    ).toBe("/collections/shoes");
  });

  it("a theme with no samples returns the sections as they were", () => {
    const sections = [] as PageSectionItem[];
    expect(
      sectionsWithoutSampleLinks(sections, {
        categories: new Set(),
        products: new Set(),
      }),
    ).toBe(sections);
  });
});

describe("every bundled theme", () => {
  it.each(THEME_DEFINITIONS.map((theme) => [theme.id, theme] as const))(
    "★ %s installs with no menu link at its own samples",
    (_id, theme) => {
      const addresses = sampleAddresses(theme);
      const menus = menusWithoutSampleLinks(theme.preset.menus, addresses);
      const links = [
        ...menus.header.flatMap(function walk(link): string[] {
          return [link.href ?? "", ...(link.children ?? []).flatMap(walk)];
        }),
        ...menus.footerGroups.flatMap((g) => g.links.map((l) => l.href)),
        ...menus.footerLegal.map((l) => l.href),
      ];
      expect(links.filter((href) => isSampleLink(href, addresses))).toEqual([]);
      expect(menus.header.length).toBeGreaterThan(0);
    },
  );
});
