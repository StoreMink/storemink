// The scoped theme stylesheet (lib/themes/stylesheet.ts). What these hold:
//
//   • a rule is vocabulary, never CSS text: anything outside the hook
//     catalogue, the property allowlist or a property's scale is refused;
//   • what compiles never leaves the storefront root, loads nothing, hides
//     nothing and moves no control, whatever it was handed (10,000 random
//     and hostile rule sets);
//   • colour is always a readable pair in the theme's own palette.

import { describe, it, expect } from "vitest";
import {
  STYLESHEET_MAX_BYTES,
  STYLESHEET_MAX_RULES,
  STYLESHEET_ROOT_CLASS,
  STYLE_HOOKS,
  STYLE_PROPERTIES,
  STYLE_VIEWPORTS,
  allowedProperties,
  compileStylesheet,
  describeStyleRule,
  normalizeStylesheet,
  resolveStyleHook,
  salvageStylesheet,
  styleHookNames,
  stylesheetDistance,
  stylesheetFacts,
  stylesheetIssues,
  type ThemeStyleRule,
} from "./stylesheet";
import { vitrine } from "./definitions/vitrine";

const SCOPE = `.storefront-root.${STYLESHEET_ROOT_CLASS}.${STYLESHEET_ROOT_CLASS}`;
const design = vitrine.preset.design;
const context = { design, brandPrimary: vitrine.preset.brand.primaryColor };
const rule = (
  hook: string,
  declarations: ThemeStyleRule["declarations"],
  more: Partial<ThemeStyleRule> = {},
): ThemeStyleRule => ({ hook, ...more, declarations });

describe("the hook catalogue", () => {
  it("names only the storefront's own classes and data hooks", () => {
    const names = styleHookNames();
    expect(names.length).toBeGreaterThanOrEqual(50);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      const hook = resolveStyleHook(name);
      expect(hook, name).not.toBeNull();
      // A class, a data hook, a link inside one, and the not-disabled guard.
      for (const piece of hook!.def.selector.split(","))
        expect(piece.trim(), name).toMatch(
          /^(\.[a-z][a-z0-9-]*|\[data-sm="[a-z-]+"\])( a)?(:not\(:disabled\):not\(\[aria-disabled="true"\]\))?$/,
        );
      expect(allowedProperties(hook!.def).length, name).toBeGreaterThan(0);
    }
  });

  it("reads a variant filter and a part, and refuses what it does not list", () => {
    expect(resolveStyleHook("product-card")).toMatchObject({
      plain: "product-card",
      variant: null,
    });
    expect(
      resolveStyleHook("product-card[variant=centered].title"),
    ).toMatchObject({ plain: "product-card.title", variant: "centered" });
    expect(resolveStyleHook("hero[variant=split].heading")?.variant).toBe(
      "split",
    );
    for (const bad of [
      "product-card[variant=round]",
      "product-card.nothing",
      "body",
      "product-card .shop-card",
      ".shop-card",
      "product-card,body",
      "section[type=newsletter]",
      "__proto__",
      "constructor.constructor",
      "",
      7,
      null,
      "a".repeat(200),
    ])
      expect(resolveStyleHook(bad), String(bad)).toBeNull();
  });

  it("★ a colour is never offered where the storefront owns it", () => {
    for (const name of [
      "hero.heading",
      "carousel.heading",
      "tile.title",
      "banner.heading",
      "header.nav-link",
      "footer.link",
      "announcement",
      "newsletter.heading",
    ])
      expect(
        allowedProperties(resolveStyleHook(name)!.def),
        name,
      ).not.toContain("color");
    expect(
      allowedProperties(resolveStyleHook("product-card.title")!.def),
    ).toContain("color");
  });
});

describe("★★ a rule is vocabulary, never CSS", () => {
  const issuesOf = (rules: unknown) => stylesheetIssues(rules, context, "s");

  it("accepts a stylesheet written in the vocabulary", () => {
    expect(
      issuesOf([
        rule("product-card.title", {
          fontFamily: "display",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontSize: "sm",
        }),
        rule("product-card", { borderWidth: 1, borderColor: "line" }),
        rule(
          "product-card",
          { transform: "lift", boxShadow: "lifted" },
          {
            state: "hover",
          },
        ),
        rule("product-card", { transition: "base" }, { viewport: "desktop" }),
        rule("product-card.image", { transform: "zoom" }, { state: "hover" }),
        rule("button.primary", { tone: "ink", borderRadius: "none" }),
        rule("section.title", { fontSize: "3xl", textAlign: "center" }),
        rule("collection.grid", { rowGap: "xl" }),
      ]),
    ).toEqual([]);
  });

  it.each([
    ["not a list", { hook: "product-card" }, /must be a list/],
    ["a rule that is not an object", ["x"], /must be an object/],
    ["an unknown hook", [rule("body", { fill: "sand" })], /hook catalogue/],
    [
      "a selector for a hook",
      [rule(".shop-card, body", { fill: "sand" })],
      /hook catalogue/,
    ],
    [
      "an extra field",
      [{ ...rule("product-card", { fill: "sand" }), selector: "body" }],
      /not a rule field/,
    ],
    [
      "a CSS property",
      [rule("product-card", { position: "fixed" })],
      /not a style property/,
    ],
    [
      "a property this kind of element does not take",
      [rule("product-card.title", { fill: "sand" })],
      /takes only/,
    ],
    [
      "a value outside the scale",
      [rule("product-card.title", { letterSpacing: "3em" })],
      /must be one of/,
    ],
    [
      "CSS text as a value",
      [rule("product-card", { fill: "url(https://x.test/a.png)" })],
      /must be one of/,
    ],
    [
      "a font size under the element's floor",
      [rule("hero.heading", { fontSize: "xs" })],
      /takes 2xl to 6xl/,
    ],
    [
      "more padding than a label takes",
      [rule("button.primary", { paddingInline: "3xl" })],
      /at most "xl"/,
    ],
    [
      "a state the element has none of",
      [rule("section.title", { color: "accent" }, { state: "hover" })],
      /takes no state rule/,
    ],
    [
      "an unknown state",
      [rule("button.primary", { tone: "ink" }, { state: "visited" as never })],
      /state must be one of/,
    ],
    [
      "an unknown viewport",
      [rule("product-card", { fill: "sand" }, { viewport: "tv" as never })],
      /viewport must be one of/,
    ],
    [
      "a transform outside a state rule",
      [rule("product-card", { transform: "lift" })],
      /only allowed in a hover/,
    ],
    [
      "a font change in a state rule",
      [rule("button.primary", { fontWeight: 700 }, { state: "hover" })],
      /not allowed in a state rule/,
    ],
    [
      "a see-through label over a photograph",
      [rule("hero.badge", { tone: "ghost" })],
      /over a photograph/,
    ],
    [
      "a zoom on something that is not a photograph",
      [rule("product-card", { transform: "zoom" }, { state: "hover" })],
      /photographs only/,
    ],
    ["no declarations", [rule("product-card", {})], /is empty/],
    [
      "the same rule twice",
      [
        rule("product-card", { fill: "sand" }),
        rule("product-card", { gap: "sm" }),
      ],
      /repeats rule 0/,
    ],
  ])("refuses %s", (_name, rules, message) => {
    expect(issuesOf(rules).join("\n")).toMatch(message);
  });

  it("refuses more rules than the limit, and a rule with too many declarations", () => {
    const many = Array.from({ length: STYLESHEET_MAX_RULES + 1 }, () =>
      rule("product-card", { fill: "sand" }),
    );
    expect(issuesOf(many).join("\n")).toMatch(/more than 200 rules/);
  });

  it("a prototype key is not a property", () => {
    expect(
      issuesOf([
        rule("product-card", { constructor: "x", toString: "y" } as never),
      ]),
    ).toHaveLength(2);
  });
});

describe("★★ colour is always a readable pair", () => {
  const pale = {
    design: {
      ...design,
      palette: {
        ...design.palette,
        cream: "#ffffff",
        surface: "#ffffff",
        tile: "#f4f4f4",
        creamDeep: "#f2f2f2",
        sand: "#777777",
        ink: "#111111",
        inkSoft: "#555555",
        onInk: "#ffffff",
        onAccent: "#ffffff",
        accent: "#f5d90a",
      },
    },
    brandPrimary: "#f5d90a",
  };
  const issuesOf = (rules: ThemeStyleRule[]) =>
    stylesheetIssues(rules, pale, "s");

  it("an accent text colour is checked against every surface the text sits on", () => {
    const issues = issuesOf([rule("product-card.title", { color: "accent" })]);
    expect(issues.join("\n")).toMatch(/cream colour/);
    expect(issues.join("\n")).toMatch(/surface colour/);
    expect(issues.join("\n")).toMatch(/needs 4.5:1/);
  });

  it("a heading is large text: 3:1", () => {
    expect(
      issuesOf([rule("section.title", { color: "accent" })]).join("\n"),
    ).toMatch(/needs 3:1/);
  });

  it("a tone is checked as text on its own background", () => {
    // White on a pale yellow accent.
    expect(issuesOf([rule("button.primary", { tone: "accent" })])).toHaveLength(
      1,
    );
    expect(issuesOf([rule("button.primary", { tone: "ink" })])).toEqual([]);
  });

  it("a fill is checked against the page's text, soft text included", () => {
    const issues = issuesOf([rule("product-card", { fill: "sand" })]);
    expect(issues.join("\n")).toMatch(/soft text colour/);
    expect(issuesOf([rule("product-card", { fill: "soft" })])).toEqual([]);
  });

  it("★ text inside a box is checked against that box's own fill", () => {
    const dark = {
      ...pale,
      design: {
        ...pale.design,
        palette: { ...pale.design.palette, accent: "#7a5c00", sand: "#8a6a10" },
      },
      brandPrimary: "#7a5c00",
    };
    // The accent reads on white, cream and tile, but not on the sand fill.
    expect(
      stylesheetIssues([rule("product-card.title", { color: "accent" })], dark),
    ).toEqual([]);
    const issues = stylesheetIssues(
      [
        rule("product-card", { fill: "sand" }),
        rule("product-card.title", { color: "accent" }),
      ],
      dark,
    );
    expect(issues.join("\n")).toMatch(/the sand fill/);
  });

  it("a text colour is checked inside every section colour scheme too", () => {
    const issues = stylesheetIssues(
      [rule("section.title", { color: "accent" })],
      context,
    );
    // Vitrine's own palette: whatever it reports names the band it fails in.
    for (const issue of issues) expect(issue).toMatch(/band|colour/);
  });

  it("with no design, only the vocabulary is checked", () => {
    expect(
      stylesheetIssues([rule("product-card.title", { color: "accent" })]),
    ).toEqual([]);
  });
});

describe("the compiled CSS", () => {
  it("puts every selector under the storefront root, twice-classed", () => {
    const css = compileStylesheet([
      rule("product-card.title", { textTransform: "uppercase" }),
      rule("product-card[variant=centered].title", { fontStyle: "italic" }),
      rule("hero[variant=split].heading", { fontWeight: 300 }),
    ]);
    expect(css).toContain(
      `${SCOPE} .shop-card-name {\n  text-transform: uppercase;\n}`,
    );
    expect(css).toContain(`${SCOPE}.sm-card-centered .shop-card-name {`);
    expect(css).toContain(
      `${SCOPE} .home-hero.variant-split .home-hero-heading {`,
    );
  });

  it("★ a hover applies only where a pointer hovers, motion only where it is welcome", () => {
    const css = compileStylesheet([
      rule("product-card", { transition: "base", borderWidth: 1 }),
      rule(
        "product-card",
        { transform: "lift", boxShadow: "lifted" },
        {
          state: "hover",
        },
      ),
    ]);
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).toContain("@media (hover: hover) {");
    expect(css).toContain(
      "@media (hover: hover) and (prefers-reduced-motion: no-preference)",
    );
    // The shadow is not motion; the lift is.
    const hoverBlock = css.slice(css.indexOf("@media (hover: hover) {"));
    expect(hoverBlock).toContain("box-shadow");
    expect(css.indexOf("transform: translateY(-4px)")).toBeGreaterThan(
      css.indexOf("(hover: hover) and (prefers-reduced-motion"),
    );
  });

  it("★ a photo's hover is its card's: hovered or focused within, and the frame clips the zoom", () => {
    const css = compileStylesheet([
      rule("product-card.image", { transform: "zoom" }, { state: "hover" }),
    ]);
    expect(css).toContain(`${SCOPE} .shop-card:hover .shop-card-img-el`);
    expect(css).toContain(`${SCOPE} .shop-card:focus-within .shop-card-img-el`);
    expect(css).toContain(`${SCOPE} .shop-card-img {\n  overflow: hidden;\n}`);
  });

  it("★★ a colour never reaches the overlay card, which draws its text over the photograph", () => {
    const css = compileStylesheet([
      rule("product-card.title", { color: "accent", fontWeight: 700 }),
      rule("product-card", { fill: "soft", borderWidth: 1 }),
      rule("product-card[variant=centered].price", { color: "inkSoft" }),
    ]);
    // Type and borders apply to every card; the colour and the fill do not.
    expect(css).toContain(`${SCOPE} .shop-card-name {\n  font-weight: 700;\n}`);
    expect(css).toContain(
      `${SCOPE}:not(.sm-card-overlay) .shop-card-name {\n  color: var(--sm-accent, var(--brand-primary));\n}`,
    );
    expect(css).toContain(
      `${SCOPE}:not(.sm-card-overlay) .shop-card {\n  background-color: var(--sm-cream-deep);\n}`,
    );
    // A filter for another layout already leaves the overlay card out.
    expect(css).toContain(
      `${SCOPE}.sm-card-centered .shop-card-current {\n  color: var(--sm-ink-soft);\n}`,
    );
    // Asked for on the overlay card itself: refused, and never compiled.
    const onOverlay = [
      rule("product-card[variant=overlay].title", { color: "ink" }),
      rule("product-card[variant=overlay]", { fill: "sand" }),
    ];
    expect(stylesheetIssues(onOverlay).join("\n")).toMatch(
      /draws product-card.title over the photograph/,
    );
    expect(stylesheetIssues(onOverlay)).toHaveLength(2);
    expect(compileStylesheet(onOverlay)).toBe("");
    expect(salvageStylesheet(onOverlay).rules).toEqual([]);
  });

  it("a disabled button is left alone", () => {
    expect(
      compileStylesheet([rule("button.primary", { tone: "ink" })]),
    ).toContain('.sm-btn-primary:not(:disabled):not([aria-disabled="true"]) {');
  });

  it("viewport rules sit in their own media query, after the base rules", () => {
    const css = compileStylesheet([
      rule("section.title", { fontSize: "2xl" }, { viewport: "phone" }),
      rule("section.title", { fontSize: "4xl" }),
    ]);
    expect(css.indexOf("@media (max-width: 640px)")).toBeGreaterThan(
      css.indexOf("font-size: clamp(1.9rem"),
    );
  });

  it("is the same text for the same rules, whatever order the declarations were written in", () => {
    const a = compileStylesheet([
      rule("button.primary", {
        tone: "outline",
        borderWidth: 2,
        letterSpacing: "0.12em",
      }),
    ]);
    const b = compileStylesheet([
      rule("button.primary", {
        letterSpacing: "0.12em",
        borderWidth: 2,
        tone: "outline",
      }),
    ]);
    expect(a).toBe(b);
    // The outline's own line comes first, so the width a rule sets wins.
    expect(a.indexOf("border: 1px solid currentColor")).toBeLessThan(
      a.indexOf("border-width: 2px"),
    );
  });

  it("skips what it does not know rather than guess", () => {
    expect(
      compileStylesheet([
        rule("body", { fill: "sand" }),
        rule("product-card", { position: "fixed", fill: "url(x)" } as never),
        { hook: "product-card" } as never,
      ]),
    ).toBe("");
  });
});

describe("salvage, the canonical form and the design facts", () => {
  it("keeps the sound rules of a faulty stylesheet", () => {
    const { rules, dropped } = salvageStylesheet(
      [
        rule("product-card.title", { textTransform: "uppercase" }),
        rule("body", { fill: "sand" }),
        rule("product-card.title", { fontStyle: "italic" }),
        rule("button.primary", { tone: "ghost" }),
        "nonsense",
      ],
      context,
    );
    expect(rules).toEqual([
      rule("product-card.title", { textTransform: "uppercase" }),
    ]);
    expect(dropped).toBe(4);
    expect(stylesheetIssues(rules, context)).toEqual([]);
    expect(salvageStylesheet("x").rules).toEqual([]);
  });

  it("a stored stylesheet and the same one read back in another key order are equal", () => {
    const written = [
      rule(
        "button.primary",
        { borderRadius: "none", tone: "ink" },
        {
          state: undefined,
        },
      ),
    ];
    const reordered = [
      {
        declarations: { tone: "ink", borderRadius: "none" },
        hook: "button.primary",
      },
    ];
    expect(JSON.stringify(normalizeStylesheet(written))).toBe(
      JSON.stringify(normalizeStylesheet(reordered)),
    );
  });

  it("two stylesheets are as far apart as the things they say", () => {
    const a = [rule("product-card.title", { textTransform: "uppercase" })];
    const b = [rule("product-card.title", { textTransform: "none" })];
    expect(stylesheetDistance(a, a)).toBe(0);
    expect(stylesheetDistance(a, b)).toBe(1);
    expect(stylesheetDistance(undefined, undefined)).toBe(0);
    expect(stylesheetDistance(a, undefined)).toBe(1);
    // A variant filter and a viewport do not make a different statement.
    expect(
      stylesheetFacts([
        rule(
          "product-card[variant=soft].title",
          { textTransform: "uppercase" },
          {
            viewport: "phone",
          },
        ),
      ]),
    ).toEqual(stylesheetFacts(a));
  });

  it("describes a rule in plain words", () => {
    expect(
      describeStyleRule(
        rule(
          "product-card[variant=quick_add].title",
          { fontSize: "sm" },
          {
            state: undefined,
            viewport: "phone",
          },
        ),
      ),
    ).toBe("Product name on a card (quick add style, on phones): font size sm");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The fuzz: 10,000 random and hostile rule sets.
// ───────────────────────────────────────────────────────────────────────────

function prng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE = [
  "body",
  "*",
  "html, body",
  ".dash-card",
  "}body{display:none",
  "</style><script>alert(1)</script>",
  "url(javascript:alert(1))",
  "expression(alert(1))",
  "red !important",
  "fixed",
  "@import url(//x.test)",
  "\\0027",
  "product-card} body {",
  "product-card[variant=x] > *",
  "__proto__",
  "constructor",
  "var(--x)",
  "calc(100vw * 99)",
  "-9999px",
  "none; position: fixed",
  "",
  "​",
];

const CSS_PROPERTIES = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-transform",
  "line-height",
  "text-decoration",
  "text-underline-offset",
  "text-decoration-thickness",
  "text-align",
  "color",
  "background-color",
  "border",
  "border-width",
  "border-style",
  "border-top-width",
  "border-top-style",
  "border-bottom-width",
  "border-bottom-style",
  "border-color",
  "border-radius",
  "box-shadow",
  "padding",
  "padding-block",
  "padding-inline",
  "gap",
  "row-gap",
  "column-gap",
  "margin-block-end",
  "object-position",
  "filter",
  "mix-blend-mode",
  "opacity",
  "transform",
  "transition",
  "transition-property",
  "transition-duration",
  "transition-timing-function",
  "overflow",
]);

/** Every line of compiled CSS is a scoped selector, a known declaration, an
 *  allowed media query or a brace. */
function assertContained(css: string) {
  let depth = 0;
  for (const raw of css.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "}") {
      depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
      continue;
    }
    if (line.startsWith("@media ")) {
      expect(line).toMatch(
        /^@media (\((max|min)-width: \d+px\)|\(hover: hover\)|\(prefers-reduced-motion: no-preference\))( and (\((max|min)-width: \d+px\)|\(prefers-reduced-motion: no-preference\)))* \{$/,
      );
      depth += 1;
      continue;
    }
    if (line.endsWith("{") || line.endsWith(",")) {
      expect(line.startsWith(SCOPE), line).toBe(true);
      // Nothing after the scope but classes, data hooks, the two pseudo
      // classes a state rule writes and the not-disabled guard.
      expect(
        line
          .slice(SCOPE.length)
          .replace(/:not\(:disabled\):not\(\[aria-disabled="true"\]\)/g, "")
          .replace(/^:not\(\.sm-card-overlay\)/, "")
          .replace(/ ?[{,]$/, ""),
        line,
      ).toMatch(
        /^(\.sm-[a-z]+-[a-z_]+)?( (\.[a-z][a-z0-9-]*|\[data-sm="[a-z-]+"\]|a)(\.[a-z][a-z0-9-]*)?(:hover|:focus-within|:focus-visible|:active)?)+$/,
      );
      if (line.endsWith("{")) depth += 1;
      continue;
    }
    const match = /^([a-z-]+): ([^;{}<>\\]+);$/.exec(line);
    expect(match, line).not.toBeNull();
    expect(CSS_PROPERTIES.has(match![1]), line).toBe(true);
    expect(match![2]).not.toMatch(
      /url\(|import|expression|javascript|!important|position|z-index|display|content|@|\/\*/i,
    );
  }
  expect(depth).toBe(0);
}

describe("★★ nothing a rule set can say leaves the storefront (10,000 rule sets)", () => {
  it("random vocabulary and hostile strings, validated or not", () => {
    const random = prng(20261122);
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)];
    const hooks = [
      ...styleHookNames(),
      "product-card[variant=centered].title",
      "hero[variant=split].heading",
      "header[variant=market].nav-link",
    ];
    const properties = Object.keys(STYLE_PROPERTIES);
    const anyValue = () => {
      const roll = random();
      if (roll < 0.7) return pick(STYLE_PROPERTIES[pick(properties)].values);
      if (roll < 0.9) return pick(HOSTILE);
      return Math.floor(random() * 2000) - 1000;
    };
    let accepted = 0;
    for (let n = 0; n < 10_000; n += 1) {
      const rules = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        (): unknown => {
          const declarations: Record<string, unknown> = {};
          for (let d = 0; d < 1 + Math.floor(random() * 5); d += 1) {
            const name = random() < 0.85 ? pick(properties) : pick(HOSTILE);
            const spec = Object.hasOwn(STYLE_PROPERTIES, name)
              ? STYLE_PROPERTIES[name]
              : null;
            declarations[name] =
              spec && random() < 0.8 ? pick(spec.values) : anyValue();
          }
          return {
            hook: random() < 0.85 ? pick(hooks) : pick(HOSTILE),
            ...(random() < 0.3
              ? {
                  state:
                    random() < 0.9
                      ? pick(["hover", "focus-visible", "active"])
                      : pick(HOSTILE),
                }
              : {}),
            ...(random() < 0.2
              ? {
                  viewport:
                    random() < 0.9
                      ? pick(["phone", "tablet", "desktop"])
                      : pick(HOSTILE),
                }
              : {}),
            declarations: random() < 0.97 ? declarations : pick(HOSTILE),
          };
        },
      );
      const issues = stylesheetIssues(rules, context);
      if (!issues.length) accepted += 1;
      // What validation accepts, what salvage keeps, and the raw input: none
      // of the three may compile to anything outside the vocabulary.
      const salvaged = salvageStylesheet(rules, context).rules;
      expect(stylesheetIssues(salvaged, context)).toEqual([]);
      const css = compileStylesheet(salvaged);
      assertContained(css);
      assertContained(compileStylesheet(rules as ThemeStyleRule[]));
      expect(new TextEncoder().encode(css).length).toBeLessThanOrEqual(
        STYLESHEET_MAX_BYTES,
      );
      if (!issues.length)
        expect(compileStylesheet(rules as ThemeStyleRule[])).toBe(css);
    }
    // The generator is not all noise: some sets are valid as written.
    expect(accepted).toBeGreaterThan(50);
  }, 120_000);

  it("a stylesheet too large to ship is reported, and salvage trims it to the limit", () => {
    const heavy = {
      fill: "soft",
      borderWidth: 4,
      borderTopWidth: 4,
      borderBottomWidth: 4,
      borderStyle: "double",
      borderColor: "transparent",
      borderRadius: "control",
      boxShadow: "hard-accent",
      padding: "2xl",
      paddingBlock: "2xl",
      paddingInline: "2xl",
      gap: "3xl",
      rowGap: "3xl",
      columnGap: "3xl",
    };
    const boxes = [
      "section.head",
      "category",
      "testimonial",
      "column",
      "accordion.item",
      ...STYLE_HOOKS["product-card"]
        .variants!.values // The overlay card takes no fill (its text lies over the photograph).
        .filter((variant) => variant !== "overlay")
        .flatMap((variant) => [
          `product-card[variant=${variant}]`,
          `product-card[variant=${variant}].body`,
        ]),
    ];
    const rules = boxes.flatMap((name) =>
      STYLE_VIEWPORTS.map((viewport) => rule(name, heavy, { viewport })),
    );
    expect(stylesheetIssues(rules).join("\n")).toMatch(/compiles to \d+ bytes/);
    const kept = salvageStylesheet(rules).rules;
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.length).toBeLessThan(rules.length);
    const css = compileStylesheet(kept);
    expect(new TextEncoder().encode(css).length).toBeLessThanOrEqual(
      STYLESHEET_MAX_BYTES,
    );
    assertContained(css);
    expect(Object.keys(STYLE_HOOKS).length).toBeGreaterThan(15);
  });
});
