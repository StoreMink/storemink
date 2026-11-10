import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The top-bar "Ask Mink AI" tab hangs 12px below the 56px top bar, at the
 * right of the content column. jsdom computes no layout, so these read the
 * stylesheet: the tab must be hidden wherever it would cover something that
 * matters (phones, the Website Builder, analytics edit mode, and every bar
 * pinned to the top of the scroll column, whose Save button sits right where
 * the tab hangs).
 */
const DASHBOARD = join(process.cwd(), "app", "dashboard");
const CSS_PATH = join(DASHBOARD, "dashboard.css");

type Rule = { selector: string; body: string; file: string };

function rulesOf(css: string, file: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({
      selector: selector.replace(/\s+/g, " ").trim(),
      body,
      file,
    }),
  );
}

function hides(body: string): boolean {
  return /display:\s*none/.test(body);
}

/** Every plain (non-module) stylesheet under app/dashboard. */
function dashboardStylesheets(dir = DASHBOARD): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...dashboardStylesheets(path));
    else if (name.endsWith(".css") && !name.endsWith(".module.css"))
      found.push(path);
  }
  return found;
}

const css = readFileSync(CSS_PATH, "utf8");
const rules = rulesOf(css, "dashboard.css");

/** The selector list of the rule that hides the tab under pinned bars. */
function pinnedBarHideSelector(): string {
  const rule = rules.find(
    (candidate) =>
      /\.dash-mink-pop(?![\w-])/.test(candidate.selector) &&
      /:has\((?=[^)]*\.dash-savebar)/.test(candidate.selector) &&
      hides(candidate.body),
  );
  if (!rule) throw new Error("No rule hides .dash-mink-pop under pinned bars");
  return rule.selector;
}

describe("the top-bar Mink AI tab", () => {
  it("is hidden below 768px", () => {
    const media = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(
        /@media\s*\(max-width:\s*767px\)\s*\{\s*([^{}]*\.dash-mink-pop(?![\w-])[^{}]*)\{([^{}]*)\}/,
      );
    expect(media).not.toBeNull();
    expect(hides(media![2])).toBe(true);
  });

  it("is hidden while the Website Builder is mounted", () => {
    expect(
      rules.some(
        (rule) =>
          rule.selector.includes(":has(.sm-builder)") &&
          /\.dash-mink-pop(?![\w-])/.test(rule.selector) &&
          hides(rule.body),
      ),
    ).toBe(true);
  });

  it("is hidden in analytics edit mode", () => {
    expect(
      rules.some(
        (rule) =>
          rule.selector.includes(".is-analytics-editing") &&
          /\.dash-mink-pop(?![\w-])/.test(rule.selector) &&
          hides(rule.body),
      ),
    ).toBe(true);
  });

  it("is hidden on every page with a bar pinned to the top of the scroll column", () => {
    const hideSelector = pinnedBarHideSelector();
    const pinned = new Set<string>();
    for (const file of dashboardStylesheets()) {
      for (const rule of rulesOf(
        readFileSync(file, "utf8"),
        relative(DASHBOARD, file),
      )) {
        // A bar pinned flush to the top cancels the column's top padding.
        if (!/top:\s*calc\([^;]*var\(--dash-pad-t/.test(rule.body)) continue;
        for (const part of rule.selector.split(",")) {
          const last = part.trim().split(/\s+/).pop() ?? "";
          const className = last.match(/\.([\w-]+)/)?.[1];
          if (className) pinned.add(className);
        }
      }
    }
    expect(pinned.size).toBeGreaterThan(0);
    const missing = [...pinned].filter(
      (className) =>
        !new RegExp(`\\.${className}(?![\\w-])`).test(hideSelector),
    );
    expect(missing).toEqual([]);
  });

  it("keeps its hover styles to a fine pointer", () => {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const fine =
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{/g;
    const blocks: string[] = [];
    let outside = "";
    let from = 0;
    for (const match of plain.matchAll(fine)) {
      const start = match.index ?? 0;
      let depth = 0;
      let end = start + match[0].length - 1;
      for (; end < plain.length; end++) {
        if (plain[end] === "{") depth++;
        else if (plain[end] === "}" && --depth === 0) break;
      }
      outside += plain.slice(from, start);
      blocks.push(plain.slice(start, end + 1));
      from = end + 1;
    }
    outside += plain.slice(from);
    // The pointer hover styles exist, and only inside a fine-pointer block.
    expect(
      blocks.some((block) => /\.dash-mink-pop[\w-]*:hover/.test(block)),
    ).toBe(true);
    expect(outside).not.toMatch(/\.dash-mink-pop[\w-]*:hover/);
  });
});
