import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Owner, 23 Nov 2026: on Muse (a stacked header under the announcement bar)
// the Saved items heading sat under the menu. Storefront pages reserved a
// fixed number for the fixed header (80 to 140px), which assumed the 68px
// bar; a stacked header is 108px, a utility header 134px, and the
// announcement bar adds 36px. Every page now starts below the header's
// MEASURED height (--sm-header-h, which use-header-fit.ts publishes), plus
// its own room, which keeps a plain 68px header where it always was.

const ROOT = "app/(storefront)";

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Every padding declaration with the selector it belongs to. */
function paddings(file: string) {
  const css = readFileSync(file, "utf8");
  const out: { selector: string; top: string; line: number }[] = [];
  const lines = css.split("\n");
  let selector = "";
  lines.forEach((text, i) => {
    const open = /^\s*([^{}@][^{}]*)\{\s*$/.exec(text);
    if (open) selector = open[1].trim();
    const padding = /^\s*padding(-top)?:\s*(calc\([^;]*\)|[^\s;]+)/.exec(text);
    if (padding) out.push({ selector, top: padding[2], line: i + 1 });
  });
  return out;
}

/** The pages that begin directly under the header, and the room each keeps
 *  below it (the fixed number it used to have, less the 68px bar). */
const PAGE_TOPS: [file: string, selector: string, room: number[]][] = [
  ["(pages)/shop/shop.css", ".shop-main", [52, 72]],
  ["(pages)/shop/shop.css", ".shop-main.pdp-page", [24, 32]],
  ["(pages)/shop/shop.css", ".shop-listing", [12, 20]],
  ["(pages)/cart/cart.css", ".cart-main", [52, 72]],
  ["(pages)/cart/cart.css", ".gcart-main", [52, 72]],
  ["(pages)/checkout/checkout.module.css", ".page", [52, 28]],
  ["(pages)/checkout/checkout.module.css", ".center", [52]],
  ["(pages)/profile/profile.module.css", ".container", [72, 42]],
  ["(pages)/enquiries/enquiries.module.css", ".container", [72, 42]],
  ["(pages)/orders/orders.module.css", ".container", [72]],
  ["(pages)/notifications/notifications.module.css", ".container", [72]],
  ["(pages)/blogs/blogs.css", ".blog-hero", [64, 12]],
  ["(pages)/blogs/blogs.css", ".blog-detail-page-section", [72, 42]],
  ["(pages)/blogs/write/write-blog.css", ".write-blog-page", [32]],
  [
    "components/account/account.css",
    ".sm-account.layout-sidebar > .sm-account-nav",
    [72, 72],
  ],
];

/** Sections that sit below other content, never under the header. */
const INNER_SECTIONS = new Set([".blog-empty-state", ".blog-related-section"]);

const BELOW_HEADER = /^calc\(var\(--sm-header-h, 68px\) \+ (\d+)px\)$/;

describe("★ every storefront page starts below the header's measured height", () => {
  it("each page that begins under the header reserves --sm-header-h plus its own room", () => {
    for (const [file, selector, room] of PAGE_TOPS) {
      const tops = paddings(join(ROOT, file)).filter(
        (p) => p.selector === selector,
      );
      expect(tops.length, `${file} ${selector}`).toBeGreaterThan(0);
      const added = tops.map((p) => {
        const match = BELOW_HEADER.exec(p.top);
        expect(match, `${file}:${p.line} ${selector} ${p.top}`).not.toBeNull();
        return Number(match![1]);
      });
      // A plain 68px header keeps the spacing these pages always had.
      expect(added, `${file} ${selector}`).toEqual(room);
    }
  });

  it("no storefront stylesheet reserves a fixed header height at the top of a page", () => {
    const fixed = cssFiles(ROOT).flatMap((file) =>
      paddings(file)
        .filter((p) => /^\d+px$/.test(p.top) && Number.parseInt(p.top) >= 80)
        .filter((p) => !INNER_SECTIONS.has(p.selector))
        .filter((p) => !/sm-header-market/.test(p.selector))
        .map((p) => `${file}:${p.line} ${p.selector} ${p.top}`),
    );
    expect(fixed).toEqual([]);
  });

  it("the header publishes the variable these pages read, with a default for each header", () => {
    const theme = readFileSync(join(ROOT, "storefront-theme.css"), "utf8");
    expect(theme).toContain(
      "--sm-header-h: calc(68px + var(--sm-announce-h));",
    );
    expect(theme).toContain(
      "--sm-header-h: calc(108px + var(--sm-announce-h));",
    );
    expect(theme).toContain(
      "--sm-header-h: calc(134px + var(--sm-announce-h));",
    );
    const hook = readFileSync(
      join(ROOT, "components/header/use-header-fit.ts"),
      "utf8",
    );
    expect(hook).toContain('root.style.setProperty("--sm-header-h"');
  });
});
