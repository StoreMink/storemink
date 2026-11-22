// @vitest-environment jsdom
// The theme's own style rules (lib/themes/stylesheet.ts) in the Website
// Builder: a read-only list under the brand panel's design controls, so a
// merchant can see what their theme brings and that it follows their colours.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: () => null,
}));

import { BrandForm } from "./chrome-form";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import {
  THEME_STYLE_RULES_SHOWN,
  themeDesignDefaults,
} from "@/lib/chrome/design";

const brand = { name: "Test store", primaryColor: "#4f46e5", logoUrl: "" };
const show = (themeDefaults = themeDesignDefaults(null)) =>
  render(
    <BrandForm
      brand={brand as never}
      onChange={vi.fn()}
      chrome={DEFAULT_CHROME}
      onChromeChange={vi.fn()}
      themeDefaults={themeDefaults}
    />,
  );

afterEach(cleanup);

describe("the theme's own style rules in the brand panel", () => {
  const styled = themeDesignDefaults(null, undefined, [
    {
      hook: "product-card.title",
      declarations: { textTransform: "uppercase", letterSpacing: "0.08em" },
    },
    {
      hook: "button.primary",
      state: "hover",
      declarations: { transform: "lift" },
    },
    // A rule this build does not know is never listed (nor compiled).
    { hook: "body", declarations: { fill: "sand" } },
  ]);

  it("are described in plain words, in the order the storefront compiles them", () => {
    expect(styled.styleRules).toEqual([
      "Product name on a card: letter spacing 0.08em; text transform uppercase",
      "Main button (on hover): transform lift",
    ]);
    expect(themeDesignDefaults(null).styleRules).toEqual([]);
    const many = themeDesignDefaults(
      null,
      undefined,
      Array.from({ length: 150 }, (_, n) => ({
        hook: "product-card.title",
        viewport: (["phone", "tablet", "desktop"] as const)[n % 3],
        state: undefined,
        declarations: { fontWeight: 300 + 100 * (n % 7) },
      })).filter((_, n) => n < 3),
    );
    expect(many.styleRules.length).toBeLessThanOrEqual(THEME_STYLE_RULES_SHOWN);
  });

  it("are listed read-only, closed until asked for", () => {
    show(styled);
    const group = screen.getByRole("button", { name: /Theme styles/ });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Product name on a card/)).toBeNull();
    fireEvent.click(group);
    expect(
      screen.getByText(
        "Product name on a card: letter spacing 0.08em; text transform uppercase",
      ).tagName,
    ).toBe("LI");
    expect(screen.getByText(/cannot be edited here/)).toBeTruthy();
    // A list, never a control.
    const list = screen.getByText(
      "Main button (on hover): transform lift",
    ).parentElement!;
    expect(list.querySelector("input, button, select, textarea")).toBeNull();
  });

  it("a theme with none shows no such group", () => {
    show();
    expect(screen.queryByRole("button", { name: /Theme styles/ })).toBeNull();
  });
});
