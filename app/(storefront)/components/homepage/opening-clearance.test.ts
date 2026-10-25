import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ★★ The opening photograph sits below the whole header (L2-J, live run
// 2026-10-22: on every revamped homepage the announcement bar pushed the
// logo and menu half over the photo). The layout itself is measured in
// Chrome by scripts/storefront-header-layout-check.mjs, which CI does not
// run, so this pins the shape of the rules that produce it: jsdom renders no
// layout, and a rule that quietly loses its reserve fails nothing else.

const read = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");

const HOME = read("app/(storefront)/components/homepage/homepage.css");
const THEME = read("app/(storefront)/storefront-theme.css");
const HEADER = read("app/(storefront)/components/header/Header.module.css");

/** The top-level rules of a stylesheet as [selector, body] pairs (an at-rule
 *  block counts as one, so a rule inside a media query is never matched). */
function topLevelRules(css: string): [string, string][] {
  const rules: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) {
        selector = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        rules.push([selector, css.slice(start, i).trim()]);
        start = i + 1;
      }
    }
  }
  return rules;
}

const squash = (s: string) => s.replace(/\s+/g, "");

/** The bodies of every top-level rule whose selector is exactly `selector`
 *  (whitespace aside): a near miss that styles something else is no match. */
function bodiesOf(css: string, selector: string): string[] {
  return topLevelRules(css)
    .filter(([own]) => squash(own) === squash(selector))
    .map(([, body]) => body);
}

describe("a photograph-led page under a solid header", () => {
  it("★★ starts below the whole header: the reserve reads the header's height, bar included", () => {
    const bodies = bodiesOf(
      HOME,
      ".storefront-root:not(.sm-header-market):not(.sm-header-transparent) .home-sections:has(> .home-section:first-child > :is(.home-hero, .home-carousel))",
    );
    expect(bodies).toHaveLength(1);
    // The measured height (or the server fallback) is the floor; the
    // section gap only wins where a theme's gap already clears the header.
    expect(bodies[0]).toMatch(
      /padding-top: max\( var\(--sm-section-gap, clamp\(40px, 6vw, 72px\)\), var\(--sm-header-h, 68px\) \);/,
    );
  });

  it("the ticker and text reserve still leaves photograph-led pages alone, so the two never stack", () => {
    const bodies = bodiesOf(
      HOME,
      ".storefront-root:not(.sm-header-market) .home-sections:has(> .home-section:first-child):not( :has( > .home-custom-code:first-child, > .home-section:first-child > .home-hero, > .home-section:first-child > .home-carousel ) )",
    );
    expect(bodies).toEqual([
      "padding-top: calc(var(--sm-header-h, 68px) + clamp(16px, 2.5vw, 32px));",
    ]);
  });

  it("★ the transparent header still floats over the photo, which starts under the opaque bar only", () => {
    const bodies = bodiesOf(
      HOME,
      ".storefront-root.sm-header-transparent .home-sections:has( > .home-section:first-child > :is(.home-hero, .home-carousel) )",
    );
    expect(bodies).toEqual(["padding-top: var(--sm-announce-h, 0px);"]);
  });

  it("★ a custom-code opening starts under the opaque bar, never behind it", () => {
    const bodies = bodiesOf(
      HOME,
      ".storefront-root.sm-announce:not(.sm-header-market) .home-sections > .home-custom-code:first-child",
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(
      /margin-top: calc\( var\(--sm-announce-h, 0px\) - var\(--sm-section-gap, clamp\(40px, 6vw, 72px\)\) \);/,
    );
  });
});

describe("--sm-header-h counts the announcement bar", () => {
  it("every server fallback adds the bar's height", () => {
    const declarations = [...THEME.matchAll(/--sm-header-h:([^;]*);/g)].map(
      (m) => m[1].trim(),
    );
    expect(declarations.length).toBeGreaterThanOrEqual(5);
    for (const value of declarations)
      expect(value).toContain("var(--sm-announce-h)");
  });

  it("the measured height includes it: the bar rides in the header's own top border", () => {
    expect(bodiesOf(HEADER, ":global(.sm-announce) .header")).toEqual([
      "border-top: var(--sm-announce-h, 36px) solid transparent;",
    ]);
  });
});
