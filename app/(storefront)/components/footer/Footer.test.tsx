// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { STOREMINK_MARK } from "@/lib/brand-assets";
import type { StoreBrand } from "@/lib/store/brand";
import type { FooterCredit } from "@/lib/store/footer-credit";

// The footer's last line (the "Powered by StoreMink" badge, a store's own
// credit line, or nothing), as decided by the storefront layout on the server
// and handed to the footer (lib/store/footer-credit.ts). Its links and its
// sign-up form are not under test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
  usePathname: () => "/",
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/app/(storefront)/components/newsletter-form", () => ({
  NewsletterForm: () => null,
}));

import Footer from "./Footer";
import styles from "./Footer.module.css";
import { BrandProvider } from "../brand-provider";

// ★ The brand carries a credit line of its own on purpose: the footer must
//   draw only the answer it is handed, never decide from brand.creditLine.
const BRAND: StoreBrand = {
  name: "Amber and Wick",
  logoUrl: null,
  primaryColor: "#17130f",
  tagline: null,
  blurb: null,
  legalName: null,
  creditLine: "Poured by hand in Kochi",
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "storemink.com",
};

function renderFooter(credit?: unknown) {
  const { container } = render(
    <BrandProvider brand={BRAND}>
      <Footer credit={credit as FooterCredit | undefined} />
    </BrandProvider>,
  );
  const lines = container.querySelectorAll('[data-sm="footer-credit"]');
  return { container, lines, line: lines[0] as HTMLElement | undefined };
}

describe("Footer credit line", () => {
  it("shows StoreMink's badge for a Free store, whatever the store's own credit line says", () => {
    const { container, line } = renderFooter({ kind: "storemink" });
    expect(line).toBeDefined();
    expect(line!.textContent).toBe("Powered byStoreMink");
    expect(line!.querySelector("img")?.getAttribute("src")).toBe(
      STOREMINK_MARK,
    );
    expect(line!.hasAttribute("aria-hidden")).toBe(false);
    expect(container.textContent).not.toContain("Poured by hand in Kochi");
  });

  it("shows the store's own line on Basic or Pro, and never the badge", () => {
    const { container, line } = renderFooter({
      kind: "custom",
      text: "Handmade in small batches",
    });
    expect(line!.textContent).toBe("Handmade in small batches");
    expect(line!.querySelector("img")).toBeNull();
    expect(line!.hasAttribute("aria-hidden")).toBe(false);
    expect(container.textContent).not.toContain("StoreMink");
  });

  it("★ keeps the line in the page, empty and hidden from screen readers, when it shows nothing", () => {
    const { container, line } = renderFooter({ kind: "none" });
    expect(line).toBeDefined();
    expect(line!.childElementCount).toBe(0);
    expect(line!.textContent).toBe("");
    expect(line!.getAttribute("aria-hidden")).toBe("true");
    // The modifier that drops its own spacing (no empty gap or box).
    expect(line!.className).toContain(styles.credit);
    expect(line!.className).toContain(styles.creditNone);
    expect(container.textContent).not.toContain("StoreMink");
    expect(container.textContent).not.toContain("Poured by hand in Kochi");
  });

  it("only a line with nothing in it carries the empty modifier", () => {
    expect(renderFooter({ kind: "storemink" }).line!.className).not.toContain(
      styles.creditNone,
    );
    expect(
      renderFooter({ kind: "custom", text: "Made by Acme" }).line!.className,
    ).not.toContain(styles.creditNone);
  });

  it("★ draws nothing there when it was handed no answer: the footer never decides for itself", () => {
    for (const credit of [
      undefined,
      null,
      {},
      { kind: "badge" },
      { kind: "custom", text: "  " },
    ]) {
      const { container, line } = renderFooter(credit);
      expect(line!.textContent, JSON.stringify(credit)).toBe("");
      expect(line!.getAttribute("aria-hidden")).toBe("true");
      expect(container.textContent).not.toContain("StoreMink");
    }
  });

  it.each([
    ["storemink", { kind: "storemink" }],
    ["custom", { kind: "custom", text: "Made by Acme" }],
    ["none", { kind: "none" }],
    ["no answer", undefined],
  ])(
    "always renders exactly one data-sm footer-credit element (%s)",
    (_name, credit) => {
      const { lines } = renderFooter(credit);
      expect(lines).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// The stylesheets, read as text (jsdom computes no layout). An empty credit
// line must draw nothing of its own in any footer variant, while the
// floating-controls room padded onto it (storefront-theme.css) still applies.
// ---------------------------------------------------------------------------

const read = (p: string) =>
  readFileSync(join(__dirname, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const moduleCss = read("Footer.module.css");
const themeCss = read("../../storefront-theme.css");

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost rule, its selector list split on top-level commas. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = m[1].trim();
    if (!prelude || prelude.startsWith("@")) continue;
    out.push({
      selectors: prelude.split(/,(?![^(]*\))/).map((s) => s.trim()),
      body: m[2],
    });
  }
  return out;
}

/** A rule body's declarations, as [property, value] pairs, lower-cased. */
function declarations(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const d of body.split(";")) {
    const colon = d.indexOf(":");
    const [name, value] =
      colon < 0 ? [d, ""] : [d.slice(0, colon), d.slice(colon + 1)];
    const property = name.trim().toLowerCase();
    if (property) out.push([property, value.trim().toLowerCase()]);
  }
  return out;
}

/** The properties a rule body declares. */
function properties(body: string): string[] {
  return declarations(body).map(([property]) => property);
}

/** Classes plus attribute selectors: enough to rank the plain selectors here
 *  (none uses :is, :where or :not; :has counts its argument, as CSS does). */
function weight(selector: string): number {
  return (
    (selector.match(/\.[A-Za-z_][\w-]*/g)?.length ?? 0) +
    (selector.match(/\[[^\]]*\]/g)?.length ?? 0)
  );
}

// ★ `.creditNone` too: a rule naming only the empty modifier must go through
//   the same checks as one naming the line (`\.credit\b` alone cannot see it,
//   since "N" continues the word). `.creditLogo` is the mark, not the line.
const creditRules = rules(moduleCss).filter((r) =>
  r.selectors.some((s) => /\.credit(None)?\b/.test(s)),
);
const EMPTY = ".credit.creditNone";

/**
 * Values that would hide the line, or take it out of the page's flow. Out of
 * flow, the floating-controls room padded onto it (storefront-theme.css) no
 * longer lengthens the page, so the chat and Privacy choices buttons and the
 * phone Add to cart bar would cover the footer's last links on every store
 * that shows nothing there; hidden, a Free store's badge would go too. The
 * VALUE is checked, never the property: `.credit` itself is `display: flex`.
 */
const HIDES_THE_LINE: Array<[string, RegExp]> = [
  ["display", /^none\b/],
  ["visibility", /^(hidden|collapse)\b/],
  ["content-visibility", /^hidden\b/],
  ["position", /^(absolute|fixed)\b/],
];

describe("the credit line's styles", () => {
  it("no rule for the credit line draws a border, background, shadow or outline, in any variant", () => {
    expect(creditRules.length).toBeGreaterThan(3);
    for (const rule of creditRules) {
      for (const property of properties(rule.body)) {
        expect(property, rule.selectors.join(", ")).not.toMatch(
          /^(border|background|box-shadow|outline)/,
        );
      }
    }
  });

  it("★ no rule for the credit line hides it or takes it out of the page, in any variant", () => {
    for (const rule of creditRules) {
      for (const [property, value] of declarations(rule.body)) {
        for (const [watched, hides] of HIDES_THE_LINE) {
          if (property !== watched) continue;
          expect(
            value,
            `${rule.selectors.join(", ")} { ${property}: ${value} }`,
          ).not.toMatch(hides);
        }
      }
    }
  });

  it("the storefront sheet only pads the credit line, never paints it", () => {
    const floating = rules(themeCss).filter((r) =>
      r.selectors.some((s) => s.includes('[data-sm="footer-credit"]')),
    );
    expect(floating.length).toBeGreaterThan(2);
    for (const rule of floating) {
      expect(properties(rule.body)).toEqual(["padding-bottom"]);
    }
  });

  it("an empty line only gives up its own spacing, and its rule comes after every other credit rule", () => {
    // Exactly one rule names the empty modifier, and it names it with the line.
    const naming = creditRules.filter((r) =>
      r.selectors.some((s) => /\.creditNone\b/.test(s)),
    );
    expect(naming).toHaveLength(1);
    expect(naming[0].selectors).toEqual([EMPTY]);
    // ★ Pinned exactly: anything more here (display, position, height,
    //   content-visibility) could take the line out of the page, and the
    //   floating-controls room with it.
    expect(declarations(naming[0].body)).toEqual([
      ["margin-top", "0"],
      ["padding-bottom", "0"],
    ]);
    // It ties with the compact variant's .credit rule and wins by order.
    expect(creditRules.at(-1)?.selectors).toEqual([EMPTY]);
  });

  it("★ every floating-controls rule outranks the empty line, so the room above the page's bottom edge stays", () => {
    const floating = rules(themeCss)
      .flatMap((r) => r.selectors)
      .filter((s) => s.includes('[data-sm="footer-credit"]'));
    expect(floating.length).toBeGreaterThan(3);
    for (const selector of floating) {
      expect(weight(selector), selector).toBeGreaterThan(weight(EMPTY));
    }
  });
});

// The "Our stores" page (owner, 22 Nov 2026): the layout tells the footer
// whether the store has one (a shop location exists and the merchant keeps
// the page on); the footer only draws the link.
describe("the Our stores link", () => {
  const storesLinks = (storesLink?: boolean) => {
    const { container } = render(
      <BrandProvider brand={BRAND}>
        <Footer credit={{ kind: "none" }} storesLink={storesLink} />
      </BrandProvider>,
    );
    return [...container.querySelectorAll('a[href="/stores"]')].map(
      (a) => a.textContent,
    );
  };

  it("leads the footer's legal row when the store has the page, and is absent otherwise", () => {
    expect(storesLinks(true)).toEqual(["Our stores"]);
    expect(storesLinks(false)).toEqual([]);
    expect(storesLinks()).toEqual([]);
  });
});
