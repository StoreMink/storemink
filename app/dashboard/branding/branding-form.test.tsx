// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StoreBrand } from "@/lib/store/brand";

// The Credit line field's words, per plan. The storefront rule is
// lib/store/footer-credit.ts: Free always shows "Powered by StoreMink", Basic
// and Pro show the store's own line or nothing. Saving is not under test.
vi.mock("@/app/actions/store-branding", () => ({
  saveStoreBranding: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: () => null,
}));

import { BrandingForm } from "./branding-form";

const BRAND: StoreBrand = {
  name: "Acme Foods",
  logoUrl: null,
  primaryColor: "#17130f",
  tagline: null,
  blurb: null,
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "storemink.com",
};

function renderForm(
  removeBadge: boolean | null,
  brand: Partial<StoreBrand> = {},
) {
  render(
    <BrandingForm
      initial={{ ...BRAND, ...brand }}
      canManage
      removeBadge={removeBadge}
    />,
  );
  const input = screen.getByLabelText("Credit line") as HTMLInputElement;
  return { input, hint: hintOf(input) };
}

/** The hint the field names with aria-describedby, as it reads now. */
function hintOf(input: HTMLInputElement): string | null {
  const hintId = input.getAttribute("aria-describedby");
  const hint = hintId ? document.getElementById(hintId) : null;
  return hint?.textContent ?? null;
}

const PAID_HINT =
  "Shown at the very bottom of your store. Leave it empty to show nothing.";
const BADGE_WORDS_HINT =
  "These are the words of StoreMink's badge, so nothing shows at the very bottom of your store. Type a line of your own, or leave it empty.";

describe("BrandingForm Credit line", () => {
  it("on Free, says the store shows Powered by StoreMink and what Basic or Pro allow", () => {
    const { input, hint } = renderForm(false);
    expect(hint).toBe(
      "Your store shows Powered by StoreMink here on the Free plan. On Basic or Pro you can show your own line, or nothing.",
    );
    expect(input.placeholder).toBe("Powered by StoreMink");
  });

  it("★ on Basic or Pro, says an empty field shows nothing, and the placeholder never suggests the badge", () => {
    const { input, hint } = renderForm(true);
    expect(hint).toBe(PAID_HINT);
    expect(input.placeholder).not.toMatch(/storemink/i);
    expect(input.placeholder).not.toMatch(/powered by/i);
  });

  it("★ on Basic or Pro, says a saved line of only the badge's words shows nothing, never that it is shown", () => {
    // The storefront's own test (isDefaultCreditWords): any case or spacing.
    for (const saved of [
      "Powered by StoreMink",
      "powered  by Store Mink",
      " POWERED BY STOREMINK ",
    ]) {
      const { input, hint } = renderForm(true, { creditLine: saved });
      expect(input.value, saved).toBe(saved);
      expect(hint, saved).toBe(BADGE_WORDS_HINT);
      cleanup();
    }
  });

  it("follows what is typed: the badge's words switch the hint, a line of the store's own switches it back", () => {
    const { input } = renderForm(true);
    expect(hintOf(input)).toBe(PAID_HINT);
    fireEvent.change(input, { target: { value: "Powered by StoreMink" } });
    expect(hintOf(input)).toBe(BADGE_WORDS_HINT);
    fireEvent.change(input, { target: { value: "Made with care in Pune" } });
    expect(hintOf(input)).toBe(PAID_HINT);
    fireEvent.change(input, { target: { value: "" } });
    expect(hintOf(input)).toBe(PAID_HINT);
  });

  it("on Free, the badge's words in the field change nothing: the badge shows either way", () => {
    const { hint } = renderForm(false, { creditLine: "Powered by StoreMink" });
    expect(hint).toBe(
      "Your store shows Powered by StoreMink here on the Free plan. On Basic or Pro you can show your own line, or nothing.",
    );
  });

  it("keeps a Free store's own saved line in the field, so it returns on an upgrade", () => {
    const { input, hint } = renderForm(false, {
      creditLine: "Made with care in Pune",
    });
    expect(input.value).toBe("Made with care in Pune");
    expect(hint).toContain("Free plan");
  });

  it("states both rules when the plan could not be read", () => {
    const { input, hint } = renderForm(null);
    expect(hint).toBe(
      "Shown at the very bottom of your store on Basic and Pro. On the Free plan, Powered by StoreMink shows here instead.",
    );
    expect(input.placeholder).toBe("");
  });

  it("uses no long or en dash in the words it shows", () => {
    for (const [removeBadge, creditLine] of [
      [false, null],
      [true, null],
      [true, "Powered by StoreMink"],
      [null, null],
    ] as const) {
      const { container } = render(
        <BrandingForm
          initial={{ ...BRAND, creditLine }}
          canManage
          removeBadge={removeBadge}
        />,
      );
      const words = [
        container.textContent ?? "",
        ...Array.from(container.querySelectorAll("input")).map(
          (el) => el.placeholder,
        ),
      ].join(" ");
      expect(words).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
