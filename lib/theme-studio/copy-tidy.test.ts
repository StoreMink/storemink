import { describe, expect, it } from "vitest";
import {
  NAV_LABEL_MAX,
  menuLabelIssues,
  navLabel,
  tidyDraftCopy,
} from "./copy-tidy";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

describe("navLabel", () => {
  it("keeps the words before a title bar", () => {
    expect(navLabel("Our Story | Roast Specialty Coffee")).toBe("Our Story");
    expect(navLabel("Brewing Guide & FAQ | Roast | Coffee")).toBe(
      "Brewing Guide & FAQ",
    );
  });
  it("leaves a plain label, and a bar with nothing before it, alone", () => {
    expect(navLabel("Shop")).toBe("Shop");
    expect(navLabel("Salt|Pepper")).toBe("Salt|Pepper");
    expect(navLabel(" | Roast")).toBe(" | Roast");
  });
});

describe("tidyDraftCopy", () => {
  const draft = {
    brand: { name: "Roast", tagline: `Good ${EM} never ordinary` },
    announcement: {
      text: `Pack of 2${EN}4 ${EM} free shipping`,
      href: "/shop",
    },
    menus: {
      header: [
        {
          label: "Shop | Roast",
          href: "/shop",
          children: [{ label: "Whole Bean | Roast", href: "/collections/a" }],
        },
      ],
      footerGroups: [
        { title: "Help", links: [{ label: "FAQ | Roast", href: "/faq" }] },
      ],
      footerLegal: [{ label: "Privacy | Roast", href: "/privacy" }],
    },
    pages: [
      {
        slug: "",
        sections: [
          {
            type: "hero",
            configJson: JSON.stringify({
              heading: `Smooth ${EM} bold`,
              list: ["a, b", `c ${EM} d`],
            }),
          },
        ],
      },
    ],
    stylesheetJson: "[]",
    count: 3,
  };

  it("rewrites every long dash, in plain fields and inside JSON strings", () => {
    const tidied = tidyDraftCopy(draft) as typeof draft;
    const whole = JSON.stringify(tidied);
    expect(whole).not.toContain(EM);
    expect(whole).not.toContain(EN);
    expect(tidied.brand.tagline).toBe("Good, never ordinary");
    expect(tidied.announcement.text).toBe("Pack of 2 to 4, free shipping");
    // The JSON field is still JSON, and its commas are its own.
    expect(JSON.parse(tidied.pages[0].sections[0].configJson)).toEqual({
      heading: "Smooth, bold",
      list: ["a, b", "c, d"],
    });
    expect(tidied.count).toBe(3);
    expect(tidied.stylesheetJson).toBe("[]");
  });

  it("shortens menu labels at every level, and nothing else", () => {
    const tidied = tidyDraftCopy(draft) as typeof draft;
    expect(tidied.menus.header[0].label).toBe("Shop");
    expect(tidied.menus.header[0].children[0].label).toBe("Whole Bean");
    expect(tidied.menus.footerGroups[0].links[0].label).toBe("FAQ");
    expect(tidied.menus.footerGroups[0].title).toBe("Help");
    expect(tidied.menus.footerLegal[0].label).toBe("Privacy");
    expect(tidied.menus.header[0].href).toBe("/shop");
  });

  it("does not change the draft it was given, and passes anything else through", () => {
    const before = JSON.stringify(draft);
    tidyDraftCopy(draft);
    expect(JSON.stringify(draft)).toBe(before);
    expect(tidyDraftCopy(null)).toBeNull();
    expect(tidyDraftCopy("text")).toBe("text");
    // A "...Json" field that is not JSON is left for its own validator.
    expect(
      (
        tidyDraftCopy({ templatesJson: `{bad ${EM}` }) as {
          templatesJson: string;
        }
      ).templatesJson,
    ).toBe(`{bad ${EM}`);
  });
});

describe("menuLabelIssues", () => {
  it("names a menu label longer than the rule allows, wherever it is", () => {
    const long = "Everything about our roasting philosophy";
    const issues = menuLabelIssues({
      menus: {
        header: [
          {
            label: "Shop",
            href: "/shop",
            children: [{ label: long, href: "/a" }],
          },
        ],
        footerGroups: [{ title: "Help", links: [{ label: long, href: "/b" }] }],
        footerLegal: [{ label: "Privacy Policy", href: "/privacy" }],
      },
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain(`a menu label is at most ${NAV_LABEL_MAX}`);
    expect(issues[0]).toContain("menus.header");
    expect(issues[1]).toContain("menus.footerGroups");
  });

  it("finds nothing in short labels, or in a draft with no menus", () => {
    expect(
      menuLabelIssues({
        menus: { header: [{ label: "Ready-to-Drink Cold Brew", href: "/c" }] },
      }),
    ).toEqual([]);
    expect(menuLabelIssues({})).toEqual([]);
    expect(menuLabelIssues(null)).toEqual([]);
  });
});
