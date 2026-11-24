import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The top-bar "Ask Mink AI" tab hangs 12px below the 56px top bar, at the
 * right of the content column. jsdom computes no layout, so these read the
 * stylesheet: the tab must be hidden wherever it would cover something that
 * matters (phones, the Website Builder, analytics edit mode, and every bar
 * pinned to the top of the scroll column, whose Save button sits right where
 * the tab hangs). A pinned bar says so with `data-dash-pinned-top`; the
 * markup half of the guard checks every element with a pinned class has it.
 */
const DASHBOARD = join(process.cwd(), "app", "dashboard");
const MARKER = "data-dash-pinned-top";
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

/** Every source file that renders markup under a directory. */
function markupFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...markupFiles(path));
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
      found.push(path);
  }
  return found;
}

/** Class names whose rule pins a bar flush to the top of the scroll column. */
function pinnedClasses(): Set<string> {
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
  return pinned;
}

/**
 * Pinned classes that never sit under the tab, each with where it is. The tab
 * hangs at the RIGHT of the content column and only from 768px; a menu pinned
 * in a column on the LEFT cannot meet it, and marking it would hide the tab on
 * every page that menu appears on. Each entry must still be pinned (a test
 * below), so a stale one fails rather than exempting nothing.
 */
const LEFT_COLUMN_PINS = new Map([
  [
    "sm-settings-rail-inner",
    "the Settings menu, a 236px column on the left (settings-shell.css)",
  ],
]);

/** The class names a JSX opening tag's className lists, as written. */
function tagClasses(tag: string): string[] {
  const attr = tag.match(/className=(?:"([^"]*)"|\{([^}]*)\})/);
  if (!attr) return [];
  return (attr[1] ?? attr[2] ?? "").split(/[^\w-]+/).filter(Boolean);
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

  it("is hidden on every page with a bar marked as pinned to the top", () => {
    expect(
      rules.some(
        (rule) =>
          rule.selector.includes(`:has([${MARKER}])`) &&
          /\.dash-mink-pop(?![\w-])/.test(rule.selector) &&
          hides(rule.body),
      ),
    ).toBe(true);
  });

  it("every element with a top-pinned class carries the marker", () => {
    const pinned = pinnedClasses();
    expect(pinned.size).toBeGreaterThan(0);
    const files = [
      ...markupFiles(DASHBOARD),
      ...markupFiles(join(process.cwd(), "components")),
    ];
    const used = new Set<string>();
    const unmarked: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [tag] of source.matchAll(/<[A-Za-z][\w.]*\s[^<>]*>/g)) {
        const classes = tagClasses(tag);
        for (const className of classes) {
          if (!pinned.has(className) || LEFT_COLUMN_PINS.has(className))
            continue;
          used.add(className);
          if (!tag.includes(MARKER))
            unmarked.push(`${relative(process.cwd(), file)}: ${className}`);
        }
      }
    }
    // The scan reached the bars it guards, and every one is marked.
    expect([...used].sort()).toEqual(
      expect.arrayContaining(["dash-offer-header", "dash-savebar"]),
    );
    expect(unmarked).toEqual([]);
  });

  it("exempts only pinned classes that sit in a left column", () => {
    const pinned = pinnedClasses();
    for (const className of LEFT_COLUMN_PINS.keys())
      expect(pinned.has(className)).toBe(true);
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
