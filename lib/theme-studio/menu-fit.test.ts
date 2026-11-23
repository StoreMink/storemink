import { describe, expect, it } from "vitest";
import {
  CENTRED_MIN_WIDTH,
  centredMenuRoom,
  menuWidth,
} from "@/lib/storefront/header-menu-room";
import { DESIGN_FONTS } from "@/lib/themes/fonts";
import type { ThemeStyleRule } from "@/lib/themes/stylesheet";
import { textWidth } from "@/lib/themes/text-width";
import type { ThemePackageV2 } from "./contracts";
import type { DesignPlan } from "./design-plan";
import { createFakeModelClient } from "./fake-provider";
import {
  fitHeaderMenuToRoom,
  headerMenuFit,
  headerMenuFitIssues,
  headerPartStyle,
  menuRoomPrompt,
  styleLengthPx,
} from "./menu-fit";
import { runThemeGeneration } from "./pipeline";

// Owner, 23 Nov 2026: "in the planning it should judge, if the logo is in
// the center, how much space is to the left, and according to that design
// the number of buttons, so that we do not have to go a line below".

const brief = {
  name: "Muse",
  brief: "An airy, minimal shop.",
  industries: ["home" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
  referenceCount: 0,
};

let built: ThemePackageV2 | null = null;
async function theme(): Promise<ThemePackageV2> {
  if (!built) {
    const outcome = await runThemeGeneration(
      createFakeModelClient(brief),
      {
        facts: {
          name: brief.name,
          themeId: "muse",
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseThemeName: null,
        },
        compile: {
          themeId: "muse",
          name: brief.name,
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseEngine: null,
          versionNumber: 1,
          modelKey: "gemini-3.8-flash",
          modelLabel: "Gemini 3.8 Flash",
          referenceDigests: [],
        },
        providerModel: "fake",
        promptVersion: "theme-studio-v1",
        messages: [{ kind: "brief", body: brief.brief }],
        references: [],
      },
      new AbortController().signal,
    );
    if (outcome.kind !== "version") throw new Error("fixture failed");
    built = outcome.package;
  }
  return structuredClone(built);
}

const MUSE_LINKS = [
  "Shop",
  "New In",
  "Collections",
  "Lookbook",
  "Our Story",
  "Journal",
  "Contact",
];
const CAPITALS: ThemeStyleRule = {
  hook: "header.nav-link",
  declarations: {
    fontFamily: "display",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
  },
};

/** A theme with a centred header, Bodoni Moda over Jost, and `labels` in
 *  its header menu (the first with a submenu, as "collections" navigation
 *  makes Shop). */
async function centred(
  labels: readonly string[],
  stylesheet: ThemeStyleRule[] = [],
  header = "centered",
): Promise<ThemePackageV2> {
  const pkg = await theme();
  const preset = pkg.definition.preset;
  preset.design.layout = {
    ...preset.design.layout,
    header: header as "centered",
  };
  preset.design.fonts = {
    body: DESIGN_FONTS.jost,
    display: DESIGN_FONTS.bodoniModa,
  };
  preset.design.page = { ...preset.design.page, width: "standard" };
  preset.stylesheet = stylesheet;
  preset.menus.header = labels.map((label, i) => ({
    label,
    href: i ? `/${label.toLowerCase().replace(/\s+/g, "-")}` : "/shop",
    ...(i === 0
      ? { children: [{ label: "Rings", href: "/collections/rings" }] }
      : {}),
  }));
  return pkg;
}

describe("headerPartStyle", () => {
  const fonts = { body: DESIGN_FONTS.jost, display: DESIGN_FONTS.bodoniModa };

  it("starts from the header's own CSS: the body font, 600, 15px", () => {
    expect(headerPartStyle("nav-link", fonts, [], "centered")).toEqual({
      font: fonts.body,
      weight: 600,
      sizePx: 15,
      letterSpacingEm: 0,
      transform: "none",
    });
    expect(
      headerPartStyle("brand", fonts, undefined, "centered"),
    ).toMatchObject({
      font: fonts.body,
      weight: 800,
      sizePx: 24,
      letterSpacingEm: -0.02,
    });
  });

  it("takes the theme's resting desktop rules, the header variant's last, and ignores hover, phone and other variants", () => {
    const rules: ThemeStyleRule[] = [
      {
        hook: "header[variant=centered].nav-link",
        declarations: { fontSize: "xs", letterSpacing: "0.2em" },
      },
      CAPITALS,
      {
        hook: "header.nav-link",
        declarations: { fontWeight: 400, letterSpacing: "0.02em" },
      },
      {
        hook: "header.nav-link",
        state: "hover",
        declarations: { letterSpacing: "0.28em" },
      },
      {
        hook: "header.nav-link",
        viewport: "phone",
        declarations: { fontSize: "base" },
      },
      {
        hook: "header[variant=minimal].nav-link",
        declarations: { fontSize: "base" },
      },
    ];
    expect(headerPartStyle("nav-link", fonts, rules, "centered")).toEqual({
      font: fonts.display,
      weight: 400,
      sizePx: 12,
      letterSpacingEm: 0.2,
      transform: "uppercase",
    });
  });

  it("evaluates the scale's clamp() sizes at the screen width", () => {
    expect(styleLengthPx("0.875rem", 1025)).toBe(14);
    // clamp(1.35rem, 1.1rem + 1vw, 1.75rem) at 1025px.
    expect(
      styleLengthPx("clamp(1.35rem, 1.1rem + 1vw, 1.75rem)", 1025),
    ).toBeCloseTo(17.6 + 10.25, 6);
    expect(styleLengthPx("clamp(1.35rem, 1.1rem + 1vw, 1.75rem)", 3000)).toBe(
      28,
    );
  });
});

describe("headerMenuFit", () => {
  it("measures the menu in the theme's own type against the room beside the logo", async () => {
    const pkg = await centred(["Shop", "Journal"]);
    const fit = headerMenuFit(pkg, "Muse")!;
    const jost = { font: DESIGN_FONTS.jost, weight: 600, sizePx: 15 };
    expect(fit.links.map((l) => [l.label, l.submenu])).toEqual([
      ["Shop", true],
      ["Journal", false],
    ]);
    expect(fit.links[1].width).toBeCloseTo(textWidth("Journal", jost)!, 6);
    expect(fit.room).toBe(
      centredMenuRoom({ pageWidth: "standard", logoWidth: 0 }),
    );
    expect(fit.width).toBe(Math.ceil(menuWidth(fit.links)));
    expect(fit.fits).toBe(true);
  });

  it("is null for every other header", async () => {
    for (const header of ["classic", "stacked", "hamburger", "minimal"])
      expect(
        headerMenuFit(await centred(MUSE_LINKS, [], header), "Muse"),
      ).toBeNull();
  });
});

describe("★ a new centred theme keeps only the links that fit beside the logo", () => {
  it("Muse's seven links in Bodoni capitals: Shop and the first pages that fit stay, the rest leave the header", async () => {
    const pkg = await centred(MUSE_LINKS, [CAPITALS]);
    expect(headerMenuFit(pkg, "Muse")!.fits).toBe(false);
    const { package: fitted, dropped } = fitHeaderMenuToRoom(pkg, "Muse");
    const kept = fitted.definition.preset.menus.header.map((l) => l.label);
    expect(kept[0]).toBe("Shop");
    expect([...kept, ...dropped]).toEqual(MUSE_LINKS);
    expect(dropped.length).toBeGreaterThan(0);
    const after = headerMenuFit(fitted, "Muse")!;
    expect(after.fits).toBe(true);
    // One more link would not have fitted.
    const next = await centred(MUSE_LINKS.slice(0, kept.length + 1), [
      CAPITALS,
    ]);
    expect(headerMenuFit(next, "Muse")!.fits).toBe(false);
    // The package it was given is untouched; the footer keeps its links.
    expect(pkg.definition.preset.menus.header).toHaveLength(7);
    expect(fitted.definition.preset.menus.footerGroups).toEqual(
      pkg.definition.preset.menus.footerGroups,
    );
  });

  it("the same seven in plain Jost keep more of them", async () => {
    const capitals = fitHeaderMenuToRoom(
      await centred(MUSE_LINKS, [CAPITALS]),
      "Muse",
    ).dropped.length;
    const plain = fitHeaderMenuToRoom(await centred(MUSE_LINKS), "Muse").dropped
      .length;
    expect(plain).toBeLessThan(capitals);
  });

  it("leaves a menu that fits, any other header, and Shop on its own, as they are", async () => {
    const short = await centred(["Shop", "Journal"]);
    expect(fitHeaderMenuToRoom(short, "Muse")).toEqual({
      package: short,
      dropped: [],
    });
    const classic = await centred(MUSE_LINKS, [CAPITALS], "classic");
    expect(fitHeaderMenuToRoom(classic, "Muse").dropped).toEqual([]);
    const huge = await centred(
      ["Shop", "The Complete Autumn Collection"],
      [
        {
          hook: "header.nav-link",
          declarations: {
            fontSize: "base",
            textTransform: "uppercase",
            letterSpacing: "0.28em",
          },
        },
      ],
    );
    const cut = fitHeaderMenuToRoom(huge, "Muse");
    expect(
      cut.package.definition.preset.menus.header.map((l) => l.label),
    ).toEqual(["Shop"]);
  });
});

describe("a change that leaves the centred menu too wide", () => {
  it("★ is sent back with the numbers and the ways to make it fit", async () => {
    const base = await centred(["Shop", "Journal"]);
    const grown = await centred(MUSE_LINKS, [CAPITALS]);
    const [issue] = headerMenuFitIssues(grown, base, "Muse");
    const fit = headerMenuFit(grown, "Muse")!;
    expect(issue).toContain(`about ${fit.room}px`);
    expect(issue).toContain(`(${CENTRED_MIN_WIDTH}px)`);
    expect(issue).toContain(`measures about ${fit.width}px`);
    expect(issue).toContain("in capitals and 0.12em letter-spacing");
    expect(issue).toContain('"Collections"');
    expect(issue).toContain('set design.layout.header to "stacked"');
  });

  it("says nothing for a menu that fits, another header, or a base whose menu was already too wide and is unchanged", async () => {
    const wide = await centred(MUSE_LINKS, [CAPITALS]);
    expect(headerMenuFitIssues(await centred(["Shop"]), wide, "Muse")).toEqual(
      [],
    );
    expect(
      headerMenuFitIssues(
        await centred(MUSE_LINKS, [CAPITALS], "classic"),
        null,
        "Muse",
      ),
    ).toEqual([]);
    expect(headerMenuFitIssues(wide, structuredClone(wide), "Muse")).toEqual(
      [],
    );
    // The same base, but this change renamed a link: it is this change's.
    const renamed = structuredClone(wide);
    renamed.definition.preset.menus.header[1].label = "Just In";
    expect(headerMenuFitIssues(renamed, wide, "Muse")).toHaveLength(1);
  });
});

describe("menuRoomPrompt", () => {
  const plan = (header: string): DesignPlan => ({
    version: 1,
    colours: {
      page: "#f7f3ee",
      surface: "#ffffff",
      ink: "#1d1b19",
      accent: "#7a4b2a",
    },
    fontPairing: "luxury-didone",
    buttons: { shape: "square", primary: "solid" },
    layout: {
      header: header as "centered",
      card: "framed",
      productDetail: "editorial",
      footer: "editorial",
      pageWidth: "standard",
      gridColumnsDesktop: 3,
      cardHoverImage: false,
    },
    layoutSource: "catalogue",
    styling: ["Names in capitals.", "Prices plain."],
    setsApart: ["Darker."],
  });

  it("tells a centred plan its menu's room, what it holds and how StoreMink keeps it", () => {
    const text = menuRoomPrompt(plan("centered"), "Muse");
    const room = centredMenuRoom({ pageWidth: "standard", logoWidth: 0 });
    expect(text).toContain(`about ${room}px on the narrowest computer screen`);
    expect(text).toContain("keeps in the header Shop and, in your page order");
    const [plain, capitals] = [
      ...text.matchAll(/about (\d+) characters|it is about (\d+)/g),
    ].map((m) => Number(m[1] ?? m[2]));
    expect(plain).toBeGreaterThan(capitals);
    expect(capitals).toBeGreaterThan(20);
    expect(text).not.toMatch(/—/);
    // The same plan, the same words.
    expect(menuRoomPrompt(plan("centered"), "Muse")).toBe(text);
  });

  it("says nothing for any other header, or no layout", () => {
    expect(menuRoomPrompt(plan("classic"), "Muse")).toBe("");
    expect(menuRoomPrompt({ ...plan("centered"), layout: null }, "Muse")).toBe(
      "",
    );
  });
});
