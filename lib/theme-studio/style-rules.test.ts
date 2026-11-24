// The theme stylesheet in Theme Studio (style-rules.ts): what Stage B is told
// it may write, and how what it writes is judged.

import { describe, expect, it } from "vitest";
import {
  STYLE_PROPERTIES,
  styleHookNames,
  stylesheetIssues,
} from "@/lib/themes/stylesheet";
import { vitrine } from "@/lib/themes/definitions/vitrine";
import { STUDIO_DESIGN_DIRECTIONS } from "./design-directions";
import { FAKE_STYLESHEET } from "./fake-provider";
import {
  DIRECTION_STYLE_VOICES,
  STYLESHEET_MIN_AREAS,
  STYLESHEET_MIN_RULES,
  parseStylesheetJson,
  stylesheetForDraft,
  stylesheetPrompt,
} from "./style-rules";

const context = {
  design: vitrine.preset.design,
  brandPrimary: vitrine.preset.brand.primaryColor,
};
const parse = (
  value: unknown,
  options: Parameters<typeof parseStylesheetJson>[3] = {},
) => {
  const issues: string[] = [];
  const rules = parseStylesheetJson(
    typeof value === "string" ? value : JSON.stringify(value),
    context,
    issues,
    options,
  );
  return { rules, issues };
};

describe("the prompt's stylesheet section", () => {
  const text = stylesheetPrompt("luxury-minimal", false);

  it("★★ prints the whole vocabulary from the catalogue: every hook, property and value", () => {
    for (const hook of styleHookNames())
      expect(text, hook).toContain(`${hook} (`);
    for (const [name, spec] of Object.entries(STYLE_PROPERTIES)) {
      expect(text, name).toContain(`\n${name}: `);
      for (const value of spec.values)
        expect(text, `${name}=${value}`).toContain(JSON.stringify(value));
    }
    expect(text).toContain("product-card[variant=<classic|quick_add|");
  });

  it("asks a new theme for its own hand, and a revision to leave the styling alone", () => {
    expect(text).toContain(
      `Write ${STYLESHEET_MIN_RULES} to 60 rules across at least ${STYLESHEET_MIN_AREAS} different areas`,
    );
    expect(text).toContain("For luxury-minimal, a good starting hand is");
    const revision = stylesheetPrompt("luxury-minimal", true);
    expect(revision).toContain("Copy it unchanged unless the operator asked");
    expect(revision).not.toContain("Write 14 to 60 rules");
  });

  it("every design direction has a starting hand, and no two are the same", () => {
    expect(Object.keys(DIRECTION_STYLE_VOICES).sort()).toEqual(
      Object.keys(STUDIO_DESIGN_DIRECTIONS).sort(),
    );
    const voices = Object.values(DIRECTION_STYLE_VOICES);
    expect(new Set(voices).size).toBe(voices.length);
    expect(stylesheetPrompt(null, false)).not.toContain("a good starting hand");
    expect(stylesheetPrompt("__proto__", false)).not.toContain(
      "a good starting hand",
    );
  });

  it("never says how to write CSS", () => {
    expect(text).toContain("You do not write CSS");
    expect(text).not.toMatch(/!important|z-index|position:/);
  });
});

describe("a draft's stylesheetJson", () => {
  it("★ the offline provider's stylesheet passes as a new theme's own", () => {
    const { rules, issues } = parse(FAKE_STYLESHEET, { requireOwnHand: true });
    expect(issues).toEqual([]);
    expect(rules).toHaveLength(FAKE_STYLESHEET.length);
    expect(stylesheetIssues(rules, context)).toEqual([]);
  });

  it("comes back in the canonical key order, whatever order it was written in", () => {
    const { rules } = parse([
      {
        declarations: { textTransform: "uppercase", fontSize: "sm" },
        hook: "product-card.title",
      },
    ]);
    expect(JSON.stringify(rules)).toBe(
      '[{"hook":"product-card.title","declarations":{"fontSize":"sm","textTransform":"uppercase"}}]',
    );
    expect(stylesheetForDraft(rules)).toBe(JSON.stringify(rules));
    expect(stylesheetForDraft(undefined)).toBe("[]");
  });

  it.each([
    ["not JSON", "[{", /not valid JSON/],
    ["a string encoded twice", JSON.stringify("[]"), /it is a string/],
    ["an object", "{}", /it is a object/],
    [
      "a rule outside the vocabulary",
      JSON.stringify([{ hook: "body", declarations: { fill: "sand" } }]),
      /hook catalogue/,
    ],
  ])("%s is a repair issue, and yields no rules", (_name, raw, message) => {
    const { rules, issues } = parse(raw);
    expect(rules).toBeUndefined();
    expect(issues.join("\n")).toMatch(message);
  });

  it("lists at most twelve issues and counts the rest", () => {
    const bad = Array.from({ length: 30 }, (_, n) => ({
      hook: `nothing-${n}`,
      declarations: { fill: "sand" },
    }));
    const { issues } = parse(bad);
    expect(issues).toHaveLength(13);
    expect(issues[12]).toMatch(/18 more problems like these/);
  });

  it("★★ a new theme must say enough to be its own; a revision need not", () => {
    const thin = [
      { hook: "product-card.title", declarations: { fontSize: "sm" } },
      { hook: "hero.heading", declarations: { fontWeight: 300 } },
    ];
    const asNew = parse(thin, { requireOwnHand: true });
    expect(asNew.issues.join("\n")).toMatch(
      /2 rules across 2 areas; a new theme needs at least 14 rules across at least 6 areas/,
    );
    expect(asNew.issues.join("\n")).toMatch(/no rule for the main button/);
    expect(asNew.issues.join("\n")).toMatch(/no rule for the section heading/);
    expect(parse(thin).issues).toEqual([]);
    expect(parse([]).rules).toBeUndefined();
    expect(parse([]).issues).toEqual([]);
  });

  it("★★ on the last attempt the sound rules are kept and nothing is reported", () => {
    const mixed = [
      { hook: "product-card.title", declarations: { fontSize: "sm" } },
      { hook: "body", declarations: { fill: "sand" } },
      { hook: "hero.heading", declarations: { fontSize: "xs" } },
    ];
    const strict = parse(mixed);
    expect(strict.rules).toBeUndefined();
    expect(strict.issues.length).toBeGreaterThan(0);
    const salvaged = parse(mixed, { salvage: true, requireOwnHand: true });
    expect(salvaged.issues).toEqual([]);
    expect(salvaged.rules).toEqual([
      { hook: "product-card.title", declarations: { fontSize: "sm" } },
    ]);
    // Nothing usable is no stylesheet, never a failure.
    expect(parse("[{", { salvage: true })).toEqual({
      rules: undefined,
      issues: [],
    });
    expect(parse("{}", { salvage: true }).issues).toEqual([]);
  });
});
