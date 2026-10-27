import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { DEFAULT_CHROME } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { MinkActorContext } from "./types";
import { validateSections } from "@/lib/sections/registry";
import { prepareSections } from "@/lib/themes/apply";
import { THEME_DEFINITIONS } from "@/lib/themes";
import {
  assertBuilderAccess,
  eligiblePages,
  summarizePersonalizationTarget,
  themeSectionIdsFor,
  type PersonalizationTarget,
  type PersonalizationTargetPage,
} from "./storefront-personalization-context";

function page(
  slug: string,
  extra: Partial<PersonalizationTargetPage> = {},
  sections: PageSectionItem[] = [],
): PersonalizationTargetPage {
  return {
    id: slug,
    slug,
    title: slug,
    status: "published",
    updatedAt: "2026-10-20 10:00:00+00",
    sections,
    sectionsDigest: "d".repeat(64),
    edited: false,
    // Fixtures are the theme's own pages unless a test says otherwise.
    themeSectionIds: sections.map((section) => section.id),
    skipped: null,
    ...extra,
  };
}

const hero: PageSectionItem = {
  id: "hero",
  type: "hero",
  enabled: true,
  config: {
    heading: "Fresh produce",
    image_url: "/themes/basket/hero.webp",
  } as never,
};

function target(
  overrides: Partial<PersonalizationTarget> = {},
): PersonalizationTarget {
  return {
    storeId: "store",
    storeName: "Lumen",
    themeName: "Basket",
    themeDesign: null,
    pages: [
      page("home", { edited: true }, [hero]),
      page("about", { edited: true }),
      page("faqs"),
      page("terms", { skipped: "policy" }),
      page("broken", { skipped: "invalid" }),
    ],
    chrome: {
      rowExists: true,
      version: null,
      value: DEFAULT_CHROME,
      designDigest: "e".repeat(64),
      textDigest: "f".repeat(64),
    },
    brand: { tagline: null, blurb: null, digest: "a".repeat(64) },
    categories: [],
    sampleProducts: [],
    facts: {
      delivery: null,
      freeDeliveryAbove: null,
      returns: null,
      pickup: false,
      onlinePayments: false,
      cashOnDelivery: true,
    },
    headroom: { period: "2026-10", planCap: 20, remaining: 14 },
    photos: { allowed: true, reason: null },
    ...overrides,
  };
}

describe("which pages a personalisation writes", () => {
  it("★ only pages still the theme's: an edited homepage waits for a yes like any page", () => {
    // The homepage used to be written however much the merchant had changed
    // it, which contradicted the prompt's "a page they edited stays out
    // unless they agree".
    expect(eligiblePages(target(), null).map((entry) => entry.slug)).toEqual([
      "faqs",
    ]);
  });

  it("an untouched homepage leads the default set", () => {
    const pages = target().pages.map((entry) =>
      entry.slug === "home" ? { ...entry, edited: false } : entry,
    );
    expect(
      eligiblePages(target({ pages }), null).map((entry) => entry.slug),
    ).toEqual(["home", "faqs"]);
  });

  it("an edited page only when it is named, and never a policy", () => {
    expect(
      eligiblePages(target(), ["about", "terms"]).map((entry) => entry.slug),
    ).toEqual(["about"]);
  });

  it("★ a photos-only pass covers every writable page by default", () => {
    expect(
      eligiblePages(target(), null, { photosOnly: true }).map(
        (entry) => entry.slug,
      ),
    ).toEqual(["home", "about", "faqs"]);
  });
});

describe("the interview summary the model reads", () => {
  it("★★ never carries a credit figure", () => {
    const pages = target().pages.map((entry) =>
      entry.slug === "home" ? { ...entry, edited: false } : entry,
    );
    const summary = summarizePersonalizationTarget(target({ pages }));
    expect(JSON.stringify(summary)).not.toMatch(
      /credit|remaining|planCap|headroom/i,
    );
    expect(summary.photos).toMatchObject({
      themePhotoSlots: 1,
      newPhotosThisTime: 1,
      available: true,
    });
  });

  it("names the pages it will never change and why", () => {
    const summary = summarizePersonalizationTarget(target());
    expect(summary.neverChanged).toEqual([
      expect.objectContaining({
        slug: "terms",
        reason: expect.stringMatching(/policy/),
      }),
      expect.objectContaining({ slug: "broken" }),
    ]);
    expect(summary.pages.find((entry) => entry.slug === "about")).toMatchObject(
      {
        editedByMerchant: true,
        includedByDefault: false,
      },
    );
  });

  it("★ counts the sections the merchant wrote, which keep their words", () => {
    const own: PageSectionItem = {
      id: "own",
      type: "testimonials",
      enabled: true,
      config: { heading: "What our customers say", items: [] } as never,
    };
    const pages = [
      page("home", {}, [hero, own]),
      // Only the hero is still the theme's.
    ].map((entry) => ({ ...entry, themeSectionIds: ["hero"] }));
    const summary = summarizePersonalizationTarget(target({ pages }));
    expect(summary.pages[0]).toMatchObject({
      merchantSections: 1,
      sampleSectionsToHide: [],
    });
  });

  it("says when not every photo fits", () => {
    const summary = summarizePersonalizationTarget(
      target({ headroom: { period: "2026-10", planCap: 20, remaining: 3 } }),
    );
    expect(summary.photos.newPhotosThisTime).toBe(0);
    expect(summary.photos).toHaveProperty("note");
  });
});

describe("which sections are still the theme's", () => {
  /** A page as an install stores it and the context reads it back. */
  function installed(
    definition: (typeof THEME_DEFINITIONS)[number],
    slug: string,
  ) {
    const prepared = prepareSections(definition, slug);
    if ("error" in prepared) throw new Error(prepared.error);
    const read = validateSections(
      JSON.parse(JSON.stringify(prepared.sections)),
      { mode: "draft" },
    );
    if ("error" in read) throw new Error(read.error);
    return read.sections;
  }

  it("★★ recognises every section of every bundled theme's pages, as installed", () => {
    // The whole rule rests on this: an install gives each section a fresh id,
    // so a section is the theme's only if its content still matches.
    for (const definition of THEME_DEFINITIONS) {
      for (const themePage of definition.preset.pages) {
        const sections = installed(definition, themePage.slug);
        const slug = themePage.slug === "" ? "home" : themePage.slug;
        expect(themeSectionIdsFor(definition, slug, sections)).toEqual(
          sections.map((section) => section.id),
        );
      }
    }
  });

  it("★ a section the merchant changed is theirs, and the rest stay the theme's", () => {
    const definition = THEME_DEFINITIONS[0];
    const sections = installed(definition, "");
    const edited = sections.map((section, index) =>
      index === 0
        ? {
            ...section,
            config: { ...section.config, heading: "Our own words" } as never,
          }
        : section,
    );
    const ids = themeSectionIdsFor(definition, "home", edited);
    expect(ids).not.toContain(edited[0].id);
    expect(ids).toEqual(edited.slice(1).map((section) => section.id));
  });

  it("claims nothing when the theme cannot be read or has no such page", () => {
    const sections = installed(THEME_DEFINITIONS[0], "");
    expect(themeSectionIdsFor(null, "home", sections)).toEqual([]);
    expect(
      themeSectionIdsFor(THEME_DEFINITIONS[0], "not-a-theme-page", sections),
    ).toEqual([]);
  });
});

describe("who may personalise", () => {
  const actor = (
    permissions: Record<string, string[]>,
    draftingEnabled = true,
  ) =>
    ({
      storeId: "store",
      adminId: "admin",
      email: null,
      roleSlug: "member",
      permissions,
      isSuperadmin: false,
      effectivePlan: "pro",
      locationIds: null,
      analyticsTimeZone: "Asia/Kolkata",
      currency: "INR",
      defaultLowStockThreshold: 5,
      requestId: "request",
      draftingEnabled,
    }) as MinkActorContext;

  it("needs Website Builder manage, and drafting, to propose", () => {
    expect(() =>
      assertBuilderAccess(actor({ builder: ["view", "manage"] }), "manage"),
    ).not.toThrow();
    expect(() =>
      assertBuilderAccess(actor({ builder: ["view"] }), "manage"),
    ).toThrow(/manage permission/);
    expect(() =>
      assertBuilderAccess(
        actor({ builder: ["view", "manage"] }, false),
        "manage",
      ),
    ).toThrow(/drafting/);
    expect(() => assertBuilderAccess(actor({}), "view")).toThrow(
      /Website Builder access/,
    );
  });
});
