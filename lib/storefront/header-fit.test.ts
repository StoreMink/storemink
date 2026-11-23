import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chooseCompaction,
  STACK_CANDIDATES,
  COMPACT_STEPS,
  STACK_STEPS,
  headerFits,
  headerRows,
  type CompactStep,
  type HeaderLayout,
} from "./header-fit";

const layout = (
  items: HeaderLayout["items"],
  width = 1000,
  scrollWidth = width,
): HeaderLayout => ({ clientWidth: width, scrollWidth, items });

describe("headerFits", () => {
  it("accepts a row with clear space between every item", () => {
    expect(
      headerFits(
        layout([
          { left: 24, right: 160 },
          { left: 200, right: 600 },
          { left: 640, right: 976 },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects items that touch or overlap", () => {
    const logo = { left: 24, right: 160 };
    expect(headerFits(layout([logo, { left: 150, right: 400 }]))).toBe(false);
    // Clear of each other, but by less than the minimum gap.
    expect(headerFits(layout([logo, { left: 165, right: 400 }]))).toBe(false);
    expect(headerFits(layout([logo, { left: 172, right: 400 }]))).toBe(true);
  });

  it("judges by position, not by the order items were read in", () => {
    // The centred header puts the menu left of the logo it follows in the DOM.
    expect(
      headerFits(
        layout([
          { left: 460, right: 600 }, // logo
          { left: 24, right: 440 }, // menu
          { left: 612, right: 976 },
        ]),
      ),
    ).toBe(true);
  });

  // Plan Phase 2d: the stacked and utility headers are two rows tall, and
  // the second row sits right under the first. Judged row by row.
  it("judges a two-row header row by row, and a header without rows as one", () => {
    const logo = { left: 460, right: 600, top: 14, bottom: 46 };
    const controls = { left: 700, right: 976, top: 10, bottom: 50 };
    const menu = { left: 200, right: 800, top: 58, bottom: 78 };
    expect(headerFits(layout([logo, controls, menu]))).toBe(true);
    // The same menu read without a vertical extent is one row with the
    // logo, which it overlaps.
    expect(
      headerFits(layout([logo, controls, { left: 200, right: 800 }])),
    ).toBe(false);
    // Rows still need their own clear space.
    expect(
      headerFits(
        layout([logo, { left: 605, right: 976, top: 10, bottom: 50 }, menu]),
      ),
    ).toBe(false);
    expect(headerRows([logo, controls, menu]).map((r) => r.length)).toEqual([
      2, 1,
    ]);
  });

  it("rejects a header wider than the screen", () => {
    expect(headerFits(layout([{ left: 24, right: 200 }], 800, 817))).toBe(
      false,
    );
  });

  it("rejects a control squeezed below its minimum", () => {
    const search = (w: number) => ({
      left: 300,
      right: 300 + w,
      minWidth: 140,
    });
    expect(headerFits(layout([search(163)]))).toBe(true);
    expect(headerFits(layout([search(100)]))).toBe(false);
  });
});

describe("chooseCompaction", () => {
  // A fake header that only fits once `fitsAt` steps are folded.
  const header = (fitsAt: number) => {
    const seen: string[] = [];
    const measure = (steps: readonly CompactStep[]) => {
      seen.push(steps.join(" "));
      return steps.length >= fitsAt
        ? layout([{ left: 0, right: 100 }])
        : layout([
            { left: 0, right: 100 },
            { left: 50, right: 200 },
          ]);
    };
    return { measure, seen };
  };

  it("folds nothing when the full header fits", () => {
    const h = header(0);
    expect(chooseCompaction(h.measure)).toEqual([]);
    expect(h.seen).toEqual([""]);
  });

  it("folds one step at a time, menu first, and stops at the first fit", () => {
    const h = header(2);
    expect(chooseCompaction(h.measure)).toEqual(["nav", "delivery"]);
    expect(h.seen).toEqual(["", "nav", "nav delivery"]);
  });

  it("folds everything when nothing else fits", () => {
    const h = header(99);
    expect(chooseCompaction(h.measure)).toEqual([...COMPACT_STEPS]);
  });

  it("★ a header that can stack never folds its menu: the right side folds first, then the menu takes its own row", () => {
    // Owner, 23 Nov 2026: Muse's centred-logo header hid every link behind
    // the hamburger on a 1440px screen; the menu now goes under the logo.
    const h = header(99);
    expect(chooseCompaction(h.measure, STACK_CANDIDATES)).toEqual([
      "stack",
      "delivery",
      "search",
    ]);
    expect(h.seen).toEqual([
      "",
      "delivery",
      "delivery search",
      "stack",
      "stack delivery",
    ]);
    expect(h.seen.some((s) => s.includes("nav"))).toBe(false);
    expect(STACK_STEPS).not.toContain("nav");
  });

  it("★ a menu that fits beside the logo stays there when only the right side is crowded", () => {
    // A centred header: the menu (left) fits; the controls (right) need the
    // delivery control folded. The menu must not move to a second row.
    const seen: string[] = [];
    const measure = (steps: readonly CompactStep[]) => {
      seen.push(steps.join(" "));
      const right = steps.includes("delivery")
        ? { left: 700, right: 980 }
        : { left: 560, right: 980 };
      return layout([
        { left: 24, right: 380 },
        { left: 450, right: 570 },
        right,
      ]);
    };
    expect(chooseCompaction(measure, STACK_CANDIDATES)).toEqual(["delivery"]);
    expect(seen).toEqual(["", "delivery"]);
  });

  it("★ the menu takes its own row only when it is what does not fit", () => {
    const seen: string[] = [];
    const measure = (steps: readonly CompactStep[]) => {
      seen.push(steps.join(" "));
      // The menu overlaps the logo until it is stacked.
      const menu = steps.includes("stack")
        ? { left: 24, right: 980, top: 80, bottom: 110 }
        : { left: 24, right: 470, top: 10, bottom: 50 };
      return layout([
        menu,
        { left: 450, right: 570, top: 10, bottom: 50 },
        { left: 700, right: 980, top: 10, bottom: 50 },
      ]);
    };
    expect(chooseCompaction(measure, STACK_CANDIDATES)).toEqual(["stack"]);
    expect(seen).toEqual(["", "delivery", "delivery search", "stack"]);
  });
});

describe("every step folds something", () => {
  // A step with no CSS behind it would be reported as taken while the header
  // still overlaps, and the drawer would never gain what it promised.
  const header = readFileSync(
    "app/(storefront)/components/header/Header.module.css",
    "utf8",
  );
  const delivery = readFileSync(
    "app/(storefront)/components/delivery/delivery-location.module.css",
    "utf8",
  );
  const rule = (css: string, selector: string) =>
    new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*display:",
    ).test(css);

  it("nav hides the menu and shows the hamburger", () => {
    expect(rule(header, '.header[data-header-compact~="nav"] .navLinks')).toBe(
      true,
    );
    expect(
      rule(header, '.header[data-header-compact~="nav"] .hamburgerBtn'),
    ).toBe(true);
  });

  it("delivery moves from the header to the drawer", () => {
    expect(
      rule(
        delivery,
        ':global([data-header-compact~="delivery"]) .root:not(.drawerRoot)',
      ),
    ).toBe(true);
    expect(
      rule(delivery, ':global([data-header-compact~="delivery"]) .drawerRoot'),
    ).toBe(true);
  });

  it("search swaps the box for the search icon", () => {
    expect(
      rule(
        header,
        '.header[data-header-compact~="search"] .searchWrap:not(.searchWrapSheet)',
      ),
    ).toBe(true);
    expect(
      rule(header, '.header[data-header-compact~="search"] .phoneSearchBtn'),
    ).toBe(true);
  });

  it("stack puts the centred header's menu on a wrapping row of its own", () => {
    const desktop = header.slice(
      header.indexOf("Centered-logo and minimal variants"),
    );
    const body = (selector: string) => {
      const at = desktop.indexOf(selector);
      expect(at).toBeGreaterThan(-1);
      const open = desktop.indexOf("{", at);
      return desktop.slice(open + 1, desktop.indexOf("}", open));
    };
    // Only inside the desktop block: tablets and phones keep the one row.
    const before = header.slice(0, header.indexOf("--sm-header-stack: 1"));
    expect(before.slice(before.lastIndexOf("@media"))).toMatch(
      /^@media \(min-width: 1025px\)/,
    );
    expect(body(":global(.sm-header-centered) .header {")).toMatch(
      /--sm-header-stack:\s*1/,
    );
    const nav = body(
      ':global(.sm-header-centered) .header[data-header-compact~="stack"] .navLinks {',
    );
    expect(nav).toMatch(/grid-row:\s*2/);
    expect(nav).toMatch(/grid-column:\s*1 \/ -1/);
    expect(nav).toMatch(/flex-wrap:\s*wrap/);
    expect(
      body(
        ':global(.sm-header-centered) .header[data-header-compact~="stack"] {',
      ),
    ).toMatch(/grid-template-rows:\s*auto auto/);
    // No other header can stack: they fold as before.
    expect(header.match(/--sm-header-stack:/g)).toHaveLength(1);
  });

  it("covers every step there is", () => {
    for (const step of [...COMPACT_STEPS, ...STACK_STEPS]) {
      expect(`${header}\n${delivery}`).toContain(
        `[data-header-compact~="${step}"]`,
      );
    }
  });
});

describe("a store name too long for the row", () => {
  // Found by the catalog capture (Track 3.6): a 29-character name ran 209px
  // under the icons of a 375px phone. Layout is not measurable in jsdom, so
  // the rules themselves are pinned; the browser check is in the parity plan.
  const header = readFileSync(
    "app/(storefront)/components/header/Header.module.css",
    "utf8",
  );
  const body = (css: string, selector: string, from = 0) => {
    const at = css.indexOf(selector, from);
    if (at < 0) return null;
    const open = css.indexOf("{", at);
    return css.slice(open + 1, css.indexOf("}", open));
  };

  it("truncates on phones instead of running under the icons", () => {
    const phone = header.slice(header.indexOf("@media (max-width: 768px)"));
    const text = body(phone, ".brandNameText {");
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
    expect(text).toMatch(/white-space:\s*nowrap/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(body(phone, ".logo {")).toMatch(/min-width:\s*0/);
  });

  it("on wider screens, truncates only once the last fold is taken", () => {
    // `search` is the one step chooseCompaction applies without measuring,
    // so letting the name shrink there cannot stand in for folding the menu.
    expect(COMPACT_STEPS.at(-1)).toBe("search");
    const text = body(
      header,
      '.header[data-header-compact~="search"] .brandNameText',
    );
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
    expect(header).not.toMatch(
      /\[data-header-compact~="(nav|delivery)"\][^{]*\.brandNameText/,
    );
  });
});
