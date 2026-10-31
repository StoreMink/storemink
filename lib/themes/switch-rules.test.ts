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
  firstTheme: false,
  launched: false,
  homepage: "seeded",
  catalogueIsSampleOnly: true,
  hasBuilderChrome: false,
  brandColorIsTheme: true,
  hasDesignOverrides: false,
};

/** A store created after 2026-10-11, before its owner has chosen a theme. */
const FIRST: ThemeSwitchFacts = {
  firstTheme: true,
  launched: false,
  homepage: "missing",
  catalogueIsSampleOnly: false,
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
  it("★ a fresh store takes the new theme's pages and menus, and loses the old samples", () => {
    expect(planThemeSwitch(FRESH, { replaceEditedHomepage: false })).toEqual({
      firstTheme: false,
      homepage: "replace",
      addMissingPages: true,
      catalogue: "remove-samples",
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

  it("★ a Builder-edited header and footer are never replaced, even with the samples removed", () => {
    expect(
      planThemeSwitch(
        { ...FRESH, hasBuilderChrome: true },
        { replaceEditedHomepage: false },
      ),
    ).toMatchObject({ catalogue: "remove-samples", menus: "keep" });
  });

  it("★★ no plan ever adds samples to a merchant's store", () => {
    for (const facts of [FRESH, FIRST]) {
      for (const sampleOnly of [true, false]) {
        for (const chrome of [true, false]) {
          const plan = planThemeSwitch(
            {
              ...facts,
              catalogueIsSampleOnly: sampleOnly,
              hasBuilderChrome: chrome,
            },
            { replaceEditedHomepage: false },
          );
          expect(["remove-samples", "keep"]).toContain(plan.catalogue);
        }
      }
    }
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

describe("planThemeSwitch on a first install", () => {
  it("★ a store takes the theme's homepage, pages, menus and colour, and no samples", () => {
    expect(planThemeSwitch(FIRST, { replaceEditedHomepage: false })).toEqual({
      firstTheme: true,
      homepage: "replace",
      addMissingPages: true,
      catalogue: "keep",
      menus: "replace",
      brandColor: "theme",
    });
  });

  it("★ a store with products of its own still gets the theme's menus (they carry no sample links)", () => {
    expect(
      planThemeSwitch(
        { ...FIRST, catalogueIsSampleOnly: false },
        { replaceEditedHomepage: false },
      ),
    ).toMatchObject({ catalogue: "keep", menus: "replace" });
  });

  it("★ a Builder header and footer keeps the theme's menus out", () => {
    expect(
      planThemeSwitch(
        { ...FIRST, hasBuilderChrome: true },
        { replaceEditedHomepage: false },
      ),
    ).toMatchObject({ catalogue: "keep", menus: "keep" });
  });

  it("never removes samples on a first install, whatever the sample fact says", () => {
    expect(
      planThemeSwitch(
        { ...FIRST, catalogueIsSampleOnly: true },
        { replaceEditedHomepage: false },
      ).catalogue,
    ).toBe("keep");
  });

  it("★ a homepage the merchant built is kept unless they ask, and the theme's pages still fill free slugs", () => {
    const built = { ...FIRST, homepage: "edited" as const };
    expect(
      planThemeSwitch(built, { replaceEditedHomepage: false }),
    ).toMatchObject({ homepage: "keep", addMissingPages: true });
    expect(
      planThemeSwitch(built, { replaceEditedHomepage: true }),
    ).toMatchObject({ homepage: "backup-and-replace", addMissingPages: true });
  });

  it("a brand colour the merchant already set stays", () => {
    expect(
      planThemeSwitch(
        { ...FIRST, brandColorIsTheme: false },
        { replaceEditedHomepage: false },
      ).brandColor,
    ).toBe("keep");
  });
});

describe("describeThemeSwitch", () => {
  it("★ says what a first install does, in place of a switch", () => {
    const lines = describeThemeSwitch(
      "Vitrine",
      FIRST,
      planThemeSwitch(FIRST, { replaceEditedHomepage: false }),
    );
    expect(lines).toEqual([
      "Your storefront gets Vitrine's colours, fonts and layout, and stops showing the store-in-progress page.",
      "Your homepage is created from Vitrine's starting design.",
      "Vitrine's starting pages are added where your store doesn't have a page yet. Pages you've already written, like your policies, are not changed.",
      "No sample products or categories are added, so your dashboard shows only what you add.",
      "Your header and footer menus are set up from Vitrine's.",
      "Your brand colour starts as Vitrine's. You can change it any time.",
      "You can switch to another theme any time.",
    ]);
    // A first install is not a switch: nothing says "change to".
    expect(lines.join(" ")).not.toMatch(/change to Vitrine/);
  });

  it("a first install over the merchant's own work says what stays", () => {
    const facts: ThemeSwitchFacts = {
      ...FIRST,
      homepage: "edited",
      hasBuilderChrome: true,
      brandColorIsTheme: false,
    };
    const lines = describeThemeSwitch(
      "Studio",
      facts,
      planThemeSwitch(facts, { replaceEditedHomepage: false }),
    );
    expect(lines).toContain(
      "Your homepage keeps its sections and their new look. Redesign it any time in the Website Builder.",
    );
    expect(lines).toContain(
      "No sample products or categories are added, so your dashboard shows only what you add.",
    );
    expect(lines).toContain(
      "Your header and footer stay as you set them in the Website Builder.",
    );
    expect(lines).toContain("Your brand colour stays as you chose it.");
    expect(lines).toContain(
      "Studio's starting pages are added where your store doesn't have a page yet. Pages you've already written, like your policies, are not changed.",
    );
  });

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
      "Your previous theme's sample products and categories are removed. Vitrine adds no samples, so your dashboard shows only what you add.",
      "Your header and footer menus change to Vitrine's.",
    ]);
  });

  it("says what stays for an established, open store", () => {
    const facts: ThemeSwitchFacts = {
      firstTheme: false,
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
    expect(lines).toContain(
      "Your products and categories are not changed, and no samples are added.",
    );
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
        firstTheme: false,
        launched: true,
        homepage: "edited" as const,
        catalogueIsSampleOnly: false,
        hasBuilderChrome: true,
        brandColorIsTheme: false,
        hasDesignOverrides: true,
      },
      FIRST,
      { ...FIRST, homepage: "edited" as const },
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
