// Layout commitments (commitments.ts): a new theme is handed the layout its
// direction allows and the catalogue uses least, so themes built one after
// another do not converge on one skeleton (as all eight did on 4 Oct 2026).

import { describe, expect, it } from "vitest";
import { EXEMPLAR_THEMES } from "@/lib/themes/exemplars";
import { PAGE_WIDTHS } from "@/lib/themes/page";
import type { ThemeDefinition } from "@/lib/themes/types";
import { themeDefinitionToPackageV2 } from "./contracts";
import {
  DIRECTION_SIGNATURES,
  commitmentIssues,
  commitmentsPrompt,
  layoutCommitments,
  type LayoutCommitments,
} from "./commitments";
import { STUDIO_DESIGN_DIRECTION_IDS } from "./design-directions";
import { themeFingerprint, type ExistingThemeFingerprint } from "./fingerprint";

const [luxury] = EXEMPLAR_THEMES;
const withLayout = (
  theme: ThemeDefinition,
  c: LayoutCommitments,
  id: string,
): ThemeDefinition => ({
  ...theme,
  id,
  preset: {
    ...theme.preset,
    design: {
      ...theme.preset.design,
      layout: {
        ...theme.preset.design.layout,
        header: c.header,
        card: c.card,
        productDetail: c.productDetail,
        footer: c.footer,
        gridColumnsDesktop: c.gridColumnsDesktop,
        cardHoverImage: c.cardHoverImage,
      },
      page: { ...theme.preset.design.page, width: c.pageWidth },
    },
  },
});
const entry = (theme: ThemeDefinition): ExistingThemeFingerprint => ({
  themeId: theme.id,
  direction: null,
  fingerprint: themeFingerprint(theme),
});

describe("the direction signatures", () => {
  it("every direction has one, made only of layouts the storefront has, and never the grocery renderer", () => {
    expect(Object.keys(DIRECTION_SIGNATURES).sort()).toEqual(
      [...STUDIO_DESIGN_DIRECTION_IDS].sort(),
    );
    for (const [id, s] of Object.entries(DIRECTION_SIGNATURES)) {
      for (const list of [
        s.headers,
        s.cards,
        s.productDetails,
        s.footers,
        s.widths,
        s.columns,
      ]) {
        expect(list.length, id).toBeGreaterThanOrEqual(2);
        expect(new Set(list as readonly unknown[]).size, id).toBe(list.length);
      }
      for (const width of s.widths) expect(PAGE_WIDTHS, id).toContain(width);
      expect(s.cards as readonly string[], id).not.toContain("grocery");
      expect(s.productDetails as readonly string[], id).not.toContain(
        "grocery",
      );
    }
  });

  it("no two directions share a whole signature", () => {
    const seen = new Set(
      Object.values(DIRECTION_SIGNATURES).map((s) => JSON.stringify(s)),
    );
    expect(seen.size).toBe(STUDIO_DESIGN_DIRECTION_IDS.length);
  });
});

describe("★★ what a new theme is committed to", () => {
  it("is always inside its direction's signature, and the same every time it is asked", () => {
    for (const direction of STUDIO_DESIGN_DIRECTION_IDS) {
      const s = DIRECTION_SIGNATURES[direction];
      for (const themeId of ["a", "harbour", "north-mill", "zz-9"]) {
        const c = layoutCommitments(direction, themeId, [])!;
        expect(s.headers, direction).toContain(c.header);
        expect(s.cards, direction).toContain(c.card);
        expect(s.productDetails, direction).toContain(c.productDetail);
        expect(s.footers, direction).toContain(c.footer);
        expect(s.widths, direction).toContain(c.pageWidth);
        expect(s.columns, direction).toContain(c.gridColumnsDesktop);
        expect(layoutCommitments(direction, themeId, [])).toEqual(c);
      }
    }
    expect(layoutCommitments(null, "a", [])).toBeNull();
    expect(layoutCommitments("vaporwave", "a", [])).toBeNull();
    expect(layoutCommitments("__proto__", "a", [])).toBeNull();
  });

  it("with an empty catalogue, different themes are still handed different layouts", () => {
    const layouts = new Set(
      Array.from({ length: 24 }, (_, n) =>
        JSON.stringify(layoutCommitments("soft-and-natural", `theme-${n}`, [])),
      ),
    );
    expect(layouts.size).toBeGreaterThan(8);
  });

  it("★★ eight themes built one after another never settle on one page width, hover setting, header or card", () => {
    // The 4 Oct 2026 batch: all eight chose the same page width and hover.
    const catalogue: ExistingThemeFingerprint[] = [];
    const made: LayoutCommitments[] = [];
    for (let n = 0; n < 8; n += 1) {
      const c = layoutCommitments(
        "classic-and-trusted",
        `batch-${n}`,
        catalogue,
      )!;
      made.push(c);
      catalogue.push(entry(withLayout(luxury, c, `batch-${n}`)));
    }
    const share = (key: keyof LayoutCommitments) => {
      const counts = new Map<string, number>();
      for (const c of made)
        counts.set(String(c[key]), (counts.get(String(c[key])) ?? 0) + 1);
      return Math.max(...counts.values()) / made.length;
    };
    // Each setting is spread as evenly as its direction's options allow.
    expect(share("cardHoverImage")).toBe(0.5);
    expect(share("pageWidth")).toBe(0.5);
    expect(share("header")).toBe(0.25);
    expect(share("card")).toBe(0.25);
    expect(share("footer")).toBeLessThanOrEqual(0.375);
    expect(share("gridColumnsDesktop")).toBe(0.5);
  });

  it("the value the catalogue already uses most is the one it avoids", () => {
    const s = DIRECTION_SIGNATURES["luxury-minimal"];
    const crowded = s.headers
      .slice(1)
      .map((header, n) =>
        entry(
          withLayout(
            luxury,
            { ...layoutCommitments("luxury-minimal", "x", [])!, header },
            `taken-${n}`,
          ),
        ),
      );
    // Every header but the first is taken once: the first is the only free one.
    for (const themeId of ["a", "b", "c", "d", "e"])
      expect(
        layoutCommitments("luxury-minimal", themeId, crowded)!.header,
      ).toBe(s.headers[0]);
  });
});

describe("the prompt section and the check", () => {
  const committed = layoutCommitments("dark-luxury", "nocturne", [])!;

  it("states every commitment as the draft writes it", () => {
    const text = commitmentsPrompt(committed, "dark-luxury");
    expect(text).toContain("For Dark luxury,");
    expect(text).toContain(`design.layout.header = "${committed.header}"`);
    expect(text).toContain(`design.page.width = "${committed.pageWidth}"`);
    expect(text).toContain(
      `design.layout.gridColumnsDesktop = ${committed.gridColumnsDesktop}`,
    );
    expect(text).toContain(
      `design.layout.cardHoverImage = ${committed.cardHoverImage}`,
    );
    expect(text).toContain("a preference of your own is not a reason");
    expect(text).not.toContain("—");
  });

  it("a draft that keeps them has nothing to answer for; one that departs is told where", () => {
    const kept = themeDefinitionToPackageV2(
      withLayout(luxury, committed, "kept"),
    );
    expect(commitmentIssues(kept, committed)).toEqual([]);
    const other: LayoutCommitments = {
      ...committed,
      header: committed.header === "minimal" ? "centered" : "minimal",
      cardHoverImage: !committed.cardHoverImage,
    };
    const issues = commitmentIssues(kept, other);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain(
      `design.layout.header is "${committed.header}", but this theme is committed to "${other.header}"`,
    );
    expect(issues[1]).toContain("design.layout.cardHoverImage");
  });

  it("a grocery storefront keeps its own card and product page", () => {
    const grocery = themeDefinitionToPackageV2({
      ...withLayout(luxury, committed, "grocer"),
      preset: {
        ...withLayout(luxury, committed, "grocer").preset,
        design: {
          ...withLayout(luxury, committed, "grocer").preset.design,
          layout: {
            ...withLayout(luxury, committed, "grocer").preset.design.layout,
            storefront: "grocery",
            card: "grocery",
            productDetail: "grocery",
          },
        },
      },
    });
    expect(commitmentIssues(grocery, committed)).toEqual([]);
  });
});
