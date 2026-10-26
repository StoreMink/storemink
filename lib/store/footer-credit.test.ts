import { describe, expect, it } from "vitest";
import { PLAN_IDS, limitsFor } from "@/lib/plans";
import {
  STOREMINK_CREDIT_WORDS,
  footerCreditFor,
  isDefaultCreditWords,
  readFooterCredit,
} from "./footer-credit";

// The footer's last line (lib/store/footer-credit.ts). The owner's rule
// (27 Oct 2026): the "Powered by StoreMink" badge appears only on a Free store.

const FREE = { removeBadge: false } as const;
const PAID = { removeBadge: true } as const;

describe("footerCreditFor on the Free plan", () => {
  it("shows StoreMink's badge when the store saved no credit line", () => {
    expect(footerCreditFor({ ...FREE, creditLine: null })).toEqual({
      kind: "storemink",
    });
    expect(footerCreditFor({ ...FREE, creditLine: undefined })).toEqual({
      kind: "storemink",
    });
  });

  it("★ shows the badge even when the store saved a line of its own (kept, not shown)", () => {
    expect(
      footerCreditFor({ ...FREE, creditLine: "Handmade in Jaipur by Acme" }),
    ).toEqual({ kind: "storemink" });
  });

  it("shows the badge for empty, whitespace-only and default-word lines", () => {
    for (const creditLine of ["", "   ", "\n\t", "powered by storemink"]) {
      expect(footerCreditFor({ ...FREE, creditLine })).toEqual({
        kind: "storemink",
      });
    }
  });
});

describe("footerCreditFor on Basic or Pro", () => {
  it("shows nothing when the store saved no credit line", () => {
    expect(footerCreditFor({ ...PAID, creditLine: null })).toEqual({
      kind: "none",
    });
    expect(footerCreditFor({ ...PAID, creditLine: undefined })).toEqual({
      kind: "none",
    });
  });

  it("shows nothing for an empty or whitespace-only line", () => {
    for (const creditLine of ["", " ", "   ", "\n", "\t \u00a0 "]) {
      expect(footerCreditFor({ ...PAID, creditLine })).toEqual({
        kind: "none",
      });
    }
  });

  it("shows the store's own line, trimmed, and never the badge", () => {
    expect(
      footerCreditFor({
        ...PAID,
        creditLine: "  Handmade in Jaipur by Acme  ",
      }),
    ).toEqual({ kind: "custom", text: "Handmade in Jaipur by Acme" });
  });

  it("★★ treats the badge's default words as nothing, in any case or spacing", () => {
    for (const creditLine of [
      "Powered by StoreMink",
      "powered by storemink",
      "POWERED BY STOREMINK",
      "  Powered by StoreMink  ",
      "Powered  by   StoreMink",
      "Powered by Store Mink",
      "PoweredByStoreMink",
      "Powered\tby\nStoreMink",
      "Powered\u00a0by\u00a0StoreMink",
    ]) {
      expect(footerCreditFor({ ...PAID, creditLine }), creditLine).toEqual({
        kind: "none",
      });
    }
  });

  it("keeps a line that only mentions StoreMink among other words", () => {
    expect(
      footerCreditFor({ ...PAID, creditLine: "Proudly powered by StoreMink" }),
    ).toEqual({ kind: "custom", text: "Proudly powered by StoreMink" });
  });
});

describe("the plan side of the decision", () => {
  it("follows PLAN_LIMITS.removeBadge: Free keeps the badge, Basic and Pro remove it", () => {
    const shown = Object.fromEntries(
      PLAN_IDS.map((plan) => [
        plan,
        footerCreditFor({
          removeBadge: limitsFor(plan).removeBadge,
          creditLine: null,
        }).kind,
      ]),
    );
    expect(shown).toEqual({ free: "storemink", basic: "none", pro: "none" });
  });
});

describe("isDefaultCreditWords", () => {
  it("matches the badge's words only", () => {
    expect(isDefaultCreditWords(STOREMINK_CREDIT_WORDS)).toBe(true);
    expect(isDefaultCreditWords("powered  by storemink")).toBe(true);
    expect(isDefaultCreditWords("Powered by Acme")).toBe(false);
    expect(isDefaultCreditWords("StoreMink")).toBe(false);
    expect(isDefaultCreditWords("")).toBe(false);
  });
});

describe("readFooterCredit", () => {
  it("passes each well-formed answer through", () => {
    expect(readFooterCredit({ kind: "storemink" })).toEqual({
      kind: "storemink",
    });
    expect(readFooterCredit({ kind: "custom", text: "Made by Acme" })).toEqual({
      kind: "custom",
      text: "Made by Acme",
    });
    expect(readFooterCredit({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("★ reads anything else as nothing, never as the badge", () => {
    for (const value of [
      undefined,
      null,
      "storemink",
      42,
      [],
      {},
      { kind: "badge" },
      { kind: "custom" },
      { kind: "custom", text: "" },
      { kind: "custom", text: "   " },
      { kind: "custom", text: 7 },
    ]) {
      expect(readFooterCredit(value), JSON.stringify(value)).toEqual({
        kind: "none",
      });
    }
  });

  it("drops any extra field a custom answer carries", () => {
    expect(
      readFooterCredit({ kind: "custom", text: " Made by Acme ", html: "<b>" }),
    ).toEqual({ kind: "custom", text: "Made by Acme" });
  });
});
