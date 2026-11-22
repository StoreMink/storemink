// Every style hook names something the storefront's own components really
// render. A hook whose class was renamed in a component would compile to CSS
// that selects nothing: the theme would quietly lose that part of its styling
// and no other test would notice. This reads the component sources.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STYLE_HOOKS,
  STYLESHEET_ROOT_CLASS,
  resolveStyleHook,
  styleHookNames,
} from "./stylesheet";

const STOREFRONT = join(process.cwd(), "app", "(storefront)");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}
const COMPONENTS = sources(STOREFRONT)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const LAYOUT = readFileSync(join(STOREFRONT, "layout.tsx"), "utf8");

/** A class or data value written in a component: bounded so "shop-card" is
 *  not satisfied by "shop-card-name". */
const rendered = (token: string) =>
  new RegExp(
    `(^|[^a-z0-9-])${token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^a-z0-9-]|$)`,
    "m",
  ).test(COMPONENTS);

describe("★★ every style hook names markup the storefront renders", () => {
  it.each(styleHookNames())("%s", (name) => {
    const { def } = resolveStyleHook(name)!;
    for (const piece of [
      def.selector,
      def.owner ?? "",
      def.frame ?? "",
    ].flatMap((selector) => selector.split(","))) {
      for (const [, cls] of piece.matchAll(/\.([a-z][a-z0-9-]*)/g))
        expect(rendered(cls), `class ${cls}`).toBe(true);
      for (const [, value] of piece.matchAll(/\[data-sm="([a-z-]+)"\]/g))
        expect(COMPONENTS, `data-sm ${value}`).toContain(`data-sm="${value}"`);
    }
  });

  it("every variant filter is a class the layout or the component writes", () => {
    for (const [base, def] of Object.entries(STYLE_HOOKS)) {
      if (!def.variants) continue;
      if (def.variants.root)
        // The layout writes `sm-card-${appearance.card}` and its siblings.
        expect(LAYOUT, base).toContain(`\`${def.variants.root}\${`);
      if (def.variants.self) {
        // ".home-hero.variant-": the element's class and its variant prefix.
        const [, element, prefix] = /^\.([a-z-]+)\.([a-z-]+)$/.exec(
          def.variants.self,
        )!;
        expect(rendered(element), base).toBe(true);
        expect(COMPONENTS, base).toContain(`${prefix}\${`);
      }
    }
    // An owned-colour exclusion is one of those root classes too.
    for (const name of styleHookNames()) {
      const owned = resolveStyleHook(name)!.def.coloursOwnedUnder;
      if (owned) expect(owned).toMatch(/^sm-card-[a-z_]+$/);
    }
  });

  it("the layout scopes the compiled rules and writes them inside the root", () => {
    expect(STYLESHEET_ROOT_CLASS).toBe("sm-styled");
    expect(LAYOUT).toContain('themeCss ? STYLESHEET_ROOT_CLASS : ""');
    expect(LAYOUT).toContain("themeStylesheetCss(theme?.preset.stylesheet)");
    expect(LAYOUT.match(/data-sm="theme-styles"/g)).toHaveLength(2);
  });
});
