import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// The storefront's floating controls (storefront-theme.css, "Floating
// controls"): the WhatsApp chat button, the Privacy choices button, the phone
// Add to cart bar and a blog's reaction bar. jsdom computes no layout, so this
// pins the contract between the stylesheet and the markup it targets: the
// part that fails SILENTLY when one side moves.
//
// ★ The rule that kept the privacy button above the Add to cart bar was
// written as `.sm-atc-sticky:has(…) [data-sm-privacy-pill]`, and could never
// match: the button renders OUTSIDE .storefront-root (merchant-tracking.tsx
// wraps the root), so nothing under the root's classes contains it. Every
// selector that reaches the button therefore starts at `body`.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

const css = read("storefront-theme.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every selector in the sheet, outside @-rule preludes. */
function selectors(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1].trim();
    if (!prelude || prelude.startsWith("@")) continue;
    for (const s of prelude.split(/,(?![^(]*\))/)) out.push(s.trim());
  }
  return out;
}

describe("floating controls", () => {
  it("every rule for the privacy button can match it, outside the storefront root", () => {
    const pillRules = selectors(css).filter((s) =>
      s.includes("[data-sm-privacy-pill]"),
    );
    expect(pillRules.length).toBeGreaterThan(2);
    for (const s of pillRules) {
      const before = s.slice(0, s.indexOf("[data-sm-privacy-pill]")).trim();
      // Bare, or reached from <body>, never from inside the root.
      expect(before === "" || before.startsWith("body:has("), s).toBe(true);
    }
  });

  it("the two buttons own opposite corners", () => {
    const chat = /\.storefront-root \.sm-wa-chat \{([^}]*)\}/.exec(css)?.[1];
    expect(chat).toMatch(/\bright:/);
    expect(chat).not.toMatch(/\bleft:/);

    const tracking = read("components/merchant-tracking.tsx");
    const pill = /data-sm-privacy-pill=""\s+className="([^"]+)"/.exec(
      tracking,
    )?.[1];
    expect(pill).toMatch(/\bleft-\d/);
    expect(pill).not.toMatch(/\bright-\d/);
  });

  it("the end-of-page room lands on a line the footer still renders", () => {
    expect(css).toContain('[data-sm="footer-credit"]');
    expect(read("components/footer/Footer.jsx")).toContain(
      'data-sm="footer-credit"',
    );
  });
});
