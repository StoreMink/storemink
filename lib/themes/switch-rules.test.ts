import { describe, expect, it } from "vitest";
import { validatePageSlug } from "@/lib/sections/registry";
import {
  describeThemeSwitch,
  homepageBackupSlug,
  homepageEditedSinceSeed,
  homepageSeedTime,
  planThemeSwitch,
  type ThemeSwitchFacts,
} from "./switch-rules";

const FRESH: ThemeSwitchFacts = {
  launched: false,
  homepage: "seeded",
  catalogueIsSampleOnly: true,
  hasBuilderChrome: false,
  brandColorIsTheme: true,
  hasDesignOverrides: false,
};

describe("homepage seed detection", () => {
  const home = {
    createdAt: "2026-10-10 09:00:00.000000+00",
    updatedAt: "2026-10-10 09:00:00.500000+00",
  };

  it("a homepage saved in the seed's own moment is the theme's", () => {
    expect(homepageEditedSinceSeed({}, home)).toBe(false);
  });

  it("a homepage saved later is the merchant's", () => {
    expect(
      homepageEditedSinceSeed(
        {},
        { ...home, updatedAt: "2026-10-10 09:05:00+00" },
      ),
    ).toBe(true);
  });

  it("★ a theme switch's own rewrite is measured from the recorded seed, not the row's creation", () => {
    // Created at signup, rewritten by a theme switch two days later. Without
    // the record this reads as the merchant's edit.
    const rewritten = {
      createdAt: "2026-10-08 09:00:00+00",
      updatedAt: "2026-10-10 12:00:00.123456+00",
    };
    expect(homepageEditedSinceSeed({}, rewritten)).toBe(true);
    const settings = {
      theme: { homepageSeededAt: "2026-10-10 12:00:00.123456+00" },
    };
    expect(homepageEditedSinceSeed(settings, rewritten)).toBe(false);
    expect(homepageSeedTime(settings, rewritten)).toBe(
      Date.parse("2026-10-10 12:00:00.123456+00"),
    );
  });

  it("ignores a recorded seed older than the row, or one that isn't a date", () => {
    expect(
      homepageSeedTime(
        { theme: { homepageSeededAt: "2020-01-01T00:00:00Z" } },
        home,
      ),
    ).toBe(Date.parse(home.createdAt));
    expect(
      homepageSeedTime({ theme: { homepageSeededAt: "soon" } }, home),
    ).toBe(Date.parse(home.createdAt));
  });

  it("no homepage row has nothing of the merchant's on it", () => {
    expect(homepageEditedSinceSeed({}, undefined)).toBe(false);
  });
});

describe("planThemeSwitch", () => {
  it("a fresh store takes the new theme's starting content wholesale", () => {
    expect(planThemeSwitch(FRESH, { replaceEditedHomepage: false })).toEqual({
      homepage: "replace",
      addMissingPages: true,
      catalogue: "swap-samples",
      menus: "replace",
      brandColor: "theme",
    });
  });

  it("★ an edited homepage is kept unless the merchant asks, and then backed up first", () => {
    const edited = { ...FRESH, homepage: "edited" as const };
    expect(
      planThemeSwitch(edited, { replaceEditedHomepage: false }),
    ).toMatchObject({ homepage: "keep", addMissingPages: false });
    expect(
      planThemeSwitch(edited, { replaceEditedHomepage: true }),
    ).toMatchObject({ homepage: "backup-and-replace", addMissingPages: true });
  });

  it("a missing homepage is created", () => {
    expect(
      planThemeSwitch(
        { ...FRESH, homepage: "missing" },
        { replaceEditedHomepage: false },
      ).homepage,
    ).toBe("replace");
  });

  it("★ a catalogue with anything of the merchant's is never touched, and the menus stay with it", () => {
    const own = { ...FRESH, catalogueIsSampleOnly: false };
    expect(
      planThemeSwitch(own, { replaceEditedHomepage: false }),
    ).toMatchObject({ catalogue: "keep", menus: "keep" });
  });

  it("★ a Builder-edited header and footer are never replaced, even with the samples swapped", () => {
    expect(
      planThemeSwitch(
        { ...FRESH, hasBuilderChrome: true },
        { replaceEditedHomepage: false },
      ),
    ).toMatchObject({ catalogue: "swap-samples", menus: "keep" });
  });

  it("a brand colour the merchant chose stays", () => {
    expect(
      planThemeSwitch(
        { ...FRESH, brandColorIsTheme: false },
        { replaceEditedHomepage: false },
      ).brandColor,
    ).toBe("keep");
  });
});

describe("describeThemeSwitch", () => {
  it("names every change for a fresh store", () => {
    const lines = describeThemeSwitch(
      "Vitrine",
      FRESH,
      planThemeSwitch(FRESH, { replaceEditedHomepage: false }),
    );
    expect(lines).toEqual([
      "Your storefront's colours, fonts and layout change to Vitrine.",
      "Your homepage is replaced with Vitrine's starting homepage. You haven't edited it yet, so nothing of yours is lost.",
      "Vitrine's other starting pages are added where your store doesn't have one. Your existing pages are not changed.",
      "The sample products and categories change to Vitrine's examples. The products stay drafts.",
      "Your header and footer menus change to Vitrine's.",
    ]);
  });

  it("says what stays for an established, open store", () => {
    const facts: ThemeSwitchFacts = {
      launched: true,
      homepage: "edited",
      catalogueIsSampleOnly: false,
      hasBuilderChrome: true,
      brandColorIsTheme: false,
      hasDesignOverrides: true,
    };
    const lines = describeThemeSwitch(
      "Studio",
      facts,
      planThemeSwitch(facts, { replaceEditedHomepage: false }),
    );
    expect(lines).toContain(
      "Your homepage keeps its sections and their new look. Redesign it any time in the Website Builder.",
    );
    expect(lines).toContain("Your products and categories are not changed.");
    expect(lines).toContain(
      "Your header and footer stay as you set them in the Website Builder.",
    );
    expect(lines).toContain("Your brand colour stays as you chose it.");
    expect(lines).toContain(
      "Colours, fonts and layouts you chose in the Website Builder stay as they are. Reset them there to use the theme's.",
    );
    expect(lines.at(-1)).toBe(
      "Your store is open, so shoppers see the change straight away.",
    );
  });

  it("tells the merchant where an edited homepage goes when they replace it", () => {
    const facts = { ...FRESH, homepage: "edited" as const };
    expect(
      describeThemeSwitch(
        "Ritual",
        facts,
        planThemeSwitch(facts, { replaceEditedHomepage: true }),
      ),
    ).toContain(
      'Your edited homepage is saved as a draft page called "Homepage before Ritual", then replaced with Ritual\'s.',
    );
  });

  it("never uses a long dash in what it tells the merchant", () => {
    for (const facts of [
      FRESH,
      {
        launched: true,
        homepage: "edited" as const,
        catalogueIsSampleOnly: false,
        hasBuilderChrome: true,
        brandColorIsTheme: false,
        hasDesignOverrides: true,
      },
    ]) {
      for (const replace of [false, true]) {
        const text = describeThemeSwitch(
          "Basket",
          facts,
          planThemeSwitch(facts, { replaceEditedHomepage: replace }),
        ).join(" ");
        expect(text).not.toMatch(/[–—]/);
      }
    }
  });
});

describe("homepageBackupSlug", () => {
  const at = new Date("2026-10-10T15:30:45Z");

  it("is a valid page slug, stamped to the minute", () => {
    const slug = homepageBackupSlug("vitrine", at);
    expect(slug).toBe("homepage-before-vitrine-20261010-1530");
    expect(validatePageSlug(slug)).toEqual({ slug });
  });

  it("stays within the page slug limit for a long Theme Studio id", () => {
    const slug = homepageBackupSlug(
      "a-very-long-theme-studio-generated-identifier-for-a-boutique",
      at,
    );
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(validatePageSlug(slug)).toEqual({ slug });
  });
});
