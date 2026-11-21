import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ★★ The builder's own top bar (Back, Save, undo, Publish) must not sit under
 * the dashboard topbar. From 2026-08-23 to 2026-10-25 it did, at every width:
 * the builder is a fixed overlay mounted inside `.dash-content`, which is
 * `relative z-10` and so a stacking context, while the topbar is
 * `relative z-40`. The builder's own z-40 only counted inside the content
 * column, the two 56px bars overlapped exactly, and merchants had no Publish
 * button in the builder. jsdom computes no stacking, so this reads the three
 * sources that decide it: if any of them changes, re-check the builder in a
 * real browser (a headless Chrome check with the real stylesheets is how the
 * fault was found).
 */
const DASHBOARD = join(process.cwd(), "app", "dashboard");
const read = (...parts: string[]) =>
  readFileSync(join(DASHBOARD, ...parts), "utf8");

function classNameOf(source: string, marker: string): string {
  const match = source.match(
    new RegExp(`className="([^"]*\\b${marker}\\b[^"]*)"`),
  );
  if (!match) throw new Error(`No element with class ${marker} found`);
  return match[1];
}

describe("Website Builder stacking", () => {
  it("still mounts the builder as a fixed overlay inside a z-10 content column", () => {
    const content = classNameOf(read("layout.tsx"), "dash-content");
    expect(content).toMatch(/\brelative\b/);
    expect(content).toMatch(/\bz-10\b/);
    const builderCss = read("builder", "builder.css");
    const overlay = builderCss.match(/\.sm-builder\s*\{([^}]*)\}/);
    expect(overlay?.[1]).toMatch(/position:\s*fixed/);
  });

  it("raises the topbar above the content column, which is why the rule below exists", () => {
    const topbar = classNameOf(read("dashboard-topbar.tsx"), "dash-topbar");
    expect(topbar).toMatch(/\brelative\b/);
    expect(topbar).toMatch(/\bz-40\b/);
  });

  it("drops the topbar under the builder while the builder is mounted", () => {
    const css = read("dashboard.css");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selector]) =>
        selector.includes(":has(.sm-builder)") &&
        // Not `\b`: a hyphen is a word boundary, so `.dash-topbar-title` would match.
        /\.dash-topbar(?![\w-])/.test(selector),
    );
    expect(rules.length).toBeGreaterThan(0);
    const zIndex = rules
      .map(([, , body]) => body.match(/z-index:\s*([^;]+);/)?.[1]?.trim())
      .find(Boolean);
    // auto (or anything below the content column's 10) lets the builder's
    // full-screen canvas paint over the topbar.
    expect(zIndex === "auto" || Number(zIndex) < 10).toBe(true);
  });

  it("hides the top-bar Ask Mink AI tab, which would paint over the builder's own top bar", () => {
    const css = read("dashboard.css");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, selector]) =>
        selector.includes(":has(.sm-builder)") &&
        /\.dash-mink-pop(?![\w-])/.test(selector),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some(([, , body]) => /display:\s*none/.test(body))).toBe(true);
  });
});
